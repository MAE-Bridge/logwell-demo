(() => {
  const SESSION_KEY = "logwell-demo-session";
  const TOUR_STEPS = [
    { id: "overview", caption: "Five synthetic services. Payments.Api is in incident from a SQL timeout.", ms: 3200 },
    { id: "filter", caption: "Filtering to Payments.Api so only that service’s logs remain.", ms: 2600 },
    { id: "open", caption: "Opening a PaymentsLedger command timeout — SqlException on capture.", ms: 3000 },
    { id: "inspect", caption: "Details include the correlation id, stack, and PaymentsLedger database.", ms: 3400 },
    { id: "context", caption: "Context shows neighboring events on the same correlation window.", ms: 3000 },
    { id: "analyze", caption: "Analyze with AI uses a cached diagnostic that only cites fields on this event.", ms: 4800 },
    { id: "done", caption: "Walkthrough finished. Keep clicking around, or press Play demo to run it again.", ms: 2800 },
  ];
  const APPS = ["Orders.Api", "Payments.Api", "Customer.Api", "Inventory.Api", "Reporting.Worker"];
  const ENVS = ["Production", "Staging", "Development"];
  const LEVELS = ["fatal", "error", "warn", "info", "debug", "unknown"];
  const RANGES = [
    { id: "5m", label: "5m", ms: 5 * 60_000 },
    { id: "15m", label: "15m", ms: 15 * 60_000 },
    { id: "1h", label: "1h", ms: 60 * 60_000 },
    { id: "6h", label: "6h", ms: 6 * 60 * 60_000 },
    { id: "24h", label: "24h", ms: 24 * 60 * 60_000 },
  ];
  const HOSTS = {
    "Orders.Api": { Production: ["ord-prod-1", "ord-prod-2"], Staging: ["ord-stg-1"], Development: ["ord-dev-1"] },
    "Payments.Api": { Production: ["pay-prod-1", "pay-prod-2"], Staging: ["pay-stg-1"], Development: ["pay-dev-1"] },
    "Customer.Api": { Production: ["cust-prod-1"], Staging: ["cust-stg-1"], Development: ["cust-dev-1"] },
    "Inventory.Api": { Production: ["inv-prod-1"], Staging: ["inv-stg-1"], Development: ["inv-dev-1"] },
    "Reporting.Worker": { Production: ["rpt-prod-1"], Staging: ["rpt-stg-1"], Development: ["rpt-dev-1"] },
  };
  const INFO = {
    "Orders.Api": ["Order submitted", "Checkout session started", "Line items validated", "Fulfillment reservation requested"],
    "Payments.Api": ["Authorization captured", "Refund queued", "Payout batch accepted", "Wallet balance checked"],
    "Customer.Api": ["Profile loaded", "Address book retrieved", "Preference snapshot published"],
    "Inventory.Api": ["Reservation committed", "Stock snapshot published", "Warehouse heartbeat"],
    "Reporting.Worker": ["Daily facts job started", "Partition checkpoint saved", "Export uploaded"],
  };

  const CACHED = {
    "database-timeout": (event) => ({
      scenarioId: "database-timeout",
      summary: `${event.source} failed while executing a database command. The logged SqlException reports that the command timed out.`,
      likelyFailureArea:
        "Payments ledger data access (LedgerRepository.GetOpenAuthorization) and the PaymentsLedger SQL dependency.",
      likelyCause:
        "The capture path waited on SQL Server until commandTimeoutSeconds elapsed. That matches a blocked session, missing index, or an overloaded PaymentsLedger rather than a client serialization bug.",
      recommendedInvestigation: [
        "Inspect SQL blocking and wait stats for PaymentsLedger around the event timestamp.",
        "Confirm command timeout and retry settings on LedgerRepository.GetOpenAuthorization.",
        "Correlate Orders.Api HTTP 504 events that carry the upstream correlation id when present.",
      ],
      confidence: "High for the failure area; medium for the exact SQL blocker, which is not in this log.",
      limitations: [
        "No SQL wait telemetry or execution plan is present in these events.",
        "This analysis uses only the selected event and correlated neighbors.",
      ],
    }),
    "http-integration": (event) => ({
      scenarioId: "http-integration",
      summary: `${event.source} failed calling a downstream HTTP API. The message reports an HTTP 504 from Payments.Api.`,
      likelyFailureArea: "Orders.Api PaymentsClient.CaptureAsync integration with Payments.Api.",
      likelyCause:
        "Checkout waited on payment capture and received a gateway timeout. Related Payments.Api errors, when present via upstreamCorrelationId, indicate the dependency itself was failing.",
      recommendedInvestigation: [
        "Open the upstream correlation id on Payments.Api if one is logged.",
        "Review PaymentsClient timeout and retry policy in Orders.Api.",
        "Check whether PlaceOrder compensated or left an unpaid order.",
      ],
      confidence:
        "High that the immediate failure is an HTTP integration timeout; downstream root cause needs the Payments.Api events.",
      limitations: [
        "This event does not include the Payments.Api stack unless a related event is in context.",
        "No network trace or packet capture is available.",
      ],
    }),
    "null-reference": (event) => ({
      scenarioId: "null-reference",
      summary: `${event.source} threw NullReferenceException while quoting shipping for a cart.`,
      likelyFailureArea: "Orders.Api domain model ShippingAddress.PostalCode used by CheckoutService.QuoteShipping.",
      likelyCause:
        "QuoteShipping read PostalCode on a missing ShippingAddress instance. The stack names get_PostalCode at ShippingAddress.cs:line 41.",
      recommendedInvestigation: [
        "Guard QuoteShipping against a null cart.ShippingAddress.",
        "Confirm the cart_17b payload actually included an address.",
        "Add a validation error instead of dereferencing optional address fields.",
      ],
      confidence: "High for the null dereference location named in the stack. The reason the address was missing is not logged.",
      limitations: ["The cart payload is not in this event.", "No user or client identifier beyond cartId is present."],
    }),
    "di-config": (event) => ({
      scenarioId: "di-config",
      summary: `${event.source} could not construct CustomerDbContext because a required configuration value was missing.`,
      likelyFailureArea: "Staging configuration and DI composition for Customer.Api.Infrastructure.CustomerDbContext.",
      likelyCause: "ConnectionStrings:CustomerDb was not found, so the container failed to activate ProfileService.",
      recommendedInvestigation: [
        "Compare Staging configuration with the Development/Production CustomerDb connection string source.",
        "Fail fast at startup when ConnectionStrings:CustomerDb is absent.",
        "Confirm the Staging secret store actually contains that key.",
      ],
      confidence: "High — the warning and InvalidOperationException both name the missing key.",
      limitations: [
        "The configuration provider (file, Key Vault, env) is not identified in these logs.",
        "No production impact can be inferred from Staging-only events.",
      ],
    }),
    "ef-core-query": (event) => ({
      scenarioId: "ef-core-query",
      summary: `${event.source} failed while iterating an EF Core query on InventoryDbContext.`,
      likelyFailureArea: "Inventory.Api StockRepository.FindLowStockAsync and the Include chain for warehouses.bins.skus.",
      likelyCause:
        "The low-stock scan exceeded its budget (warn at 2s) and then threw while opening or reading the relational connection. That is consistent with a heavy Include graph or missing index, not a JSON parser error.",
      recommendedInvestigation: [
        "Capture the actual SQL for FindLowStockAsync and look for scans on warehouseId 12.",
        "Split the Include of warehouses.bins.skus or add a projection.",
        "Check connection pool exhaustion on inv-prod-1 around the timestamp.",
      ],
      confidence: "Medium-high for the query as the failure area. The exact SQL blocker is not logged.",
      limitations: [
        "No SQL text or duration histogram is attached to the error itself.",
        "DbUpdateException here is the logged type; the inner exception is not present.",
      ],
    }),
    "assembly-load": (event) => ({
      scenarioId: "assembly-load",
      summary: `${event.source} failed to load Inventory.Contracts while the catalog sync worker started.`,
      likelyFailureArea: "Staging deployment of Inventory.Api / Inventory.Contracts 2.4.0.0.",
      likelyCause:
        "FileNotFoundException for Inventory.Contracts, Version=2.4.0.0 means the worker process started without that assembly beside it.",
      recommendedInvestigation: [
        "Compare the Staging publish output with the Inventory.Contracts package version.",
        "Verify CatalogSyncWorker does not load contracts from an unexpected AssemblyLoadContext.",
        "Confirm the Staging image actually copied the 2.4.0.0 binary.",
      ],
      confidence: "High — the exception and assembly name are explicit.",
      limitations: ["The probe does not include directory listings or fusion logs.", "Production may not share this package layout."],
    }),
    "slow-dependency": (event) => ({
      scenarioId: "slow-dependency",
      summary: `${event.source} timed out waiting on warehouse-analytics while running DailySalesJob.`,
      likelyFailureArea: "Reporting.Worker WarehouseClient.QueryFactsAsync dependency.",
      likelyCause:
        "The worker logged that QueryFactsAsync was still running at 15s and then threw TimeoutException at timeoutMs. The job did not fail in-process; the remote warehouse query did not return in time.",
      recommendedInvestigation: [
        "Check warehouse-analytics latency for the same timestamp.",
        "Decide whether DailySalesJob should checkpoint partial facts instead of failing.",
        "Review timeoutMs versus the warning threshold of 15000ms.",
      ],
      confidence: "High for a slow dependency timeout; the warehouse's internal cause is not in these logs.",
      limitations: ["No warehouse-analytics logs are included.", "Query payload and row counts are not present."],
    }),
    "auth-session": (event) => ({
      scenarioId: "auth-session",
      summary: `${event.source} rejected a payout request because the merchant session was not authorized.`,
      likelyFailureArea: "Payments.Api JWT bearer authentication and MerchantContext.RequireActiveSession on /v1/payouts.",
      likelyCause:
        "A warn event reports JWT expired for merchant mch_204, then UnauthorizedAccessException is thrown from RequireActiveSession. That is an expired or invalid session, not a SQL failure.",
      recommendedInvestigation: [
        "Confirm token lifetime versus clock skew for merchant mch_204.",
        "Return 401 at the JWT middleware instead of throwing from RequireActiveSession.",
        "Check whether the client should refresh before calling /v1/payouts.",
      ],
      confidence: "High that the request lacked a valid session. Why the token expired is not logged.",
      limitations: ["No token claims or expiry timestamp are in the event.", "Client identity beyond merchantId is not present."],
    }),
  };

  const state = {
    events: [],
    draft: "",
    query: "",
    range: "1h",
    live: false,
    sources: [],
    levels: [],
    environments: [],
    exceptionTypes: [],
    windowOverride: null,
    selectedId: null,
    inspectorTab: "details",
    analysis: null,
    analyzing: false,
    sidebarOpen: false,
    aboutOpen: false,
    now: Date.now(),
    tour: "idle",
    tourStep: 0,
    tourTimer: null,
    tourDriving: false,
  };

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a += 0x6d2b79f5;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function pick(rand, items) {
    return items[Math.floor(rand() * items.length)];
  }
  function minutesAgo(now, minutes, jitterMs = 0) {
    return now - Math.round(minutes * 60_000) - jitterMs;
  }
  function iso(at) {
    return new Date(at).toISOString();
  }
  function field(event, names) {
    for (const name of names) {
      if (event.fields[name]) return event.fields[name];
      const match = Object.entries(event.fields).find(([key]) => key.toLowerCase() === name.toLowerCase());
      if (match?.[1]) return match[1];
    }
    return undefined;
  }
  function formatClock(ts) {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }
  function formatStamp(ts) {
    const date = new Date(ts);
    return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${formatClock(ts)}`;
  }
  function healthStatus(errorCount, count) {
    if (count === 0) return "healthy";
    const rate = errorCount / count;
    if (errorCount >= 8 || rate >= 0.08) return "incident";
    if (errorCount >= 2 || rate >= 0.02) return "degraded";
    return "healthy";
  }
  function rangeMs(id) {
    return RANGES.find((range) => range.id === id)?.ms ?? 60 * 60_000;
  }
  function makeEvent(at, rec) {
    const skip = new Set(["eventId", "level", "service", "host", "environment", "msg", "ts", "stack"]);
    const fields = {};
    for (const [key, value] of Object.entries(rec)) {
      if (skip.has(key) || value == null) continue;
      fields[key] = Array.isArray(value) || typeof value === "object" ? JSON.stringify(value) : String(value);
    }
    const stackFrames = Array.isArray(rec.stack) ? rec.stack.map(String) : undefined;
    const payload = { ts: iso(at), ...rec };
    return {
      id: String(rec.eventId),
      timestamp: at,
      receivedAt: at,
      level: rec.level,
      source: rec.service,
      host: rec.host,
      message: rec.msg,
      raw: JSON.stringify(payload),
      fields,
      environment: rec.environment,
      exceptionType: rec.exceptionType,
      correlationId: rec.correlationId,
      stackFrames,
    };
  }

  function buildCatalog(now) {
    const rand = mulberry32(20260911);
    const events = [];
    for (let i = 0; i < 220; i += 1) {
      const environment = rand() < 0.76 ? "Production" : "Staging";
      const source = pick(rand, APPS);
      const host = pick(rand, HOSTS[source][environment]);
      const levelRoll = rand();
      const level = levelRoll < 0.04 ? "warn" : levelRoll < 0.1 ? "debug" : "info";
      events.push(
        makeEvent(now - Math.floor(rand() * 15 * 60_000), {
          eventId: `seed-fill-${String(i).padStart(3, "0")}`,
          level,
          service: source,
          host,
          environment,
          msg: level === "warn" ? "upstream latency above SLO" : level === "debug" ? "handler entered" : pick(rand, INFO[source]),
          requestId: `req_fill_${String(i).padStart(3, "0")}`,
          latencyMs: Math.round(12 + rand() * 240),
        }),
      );
    }

    const payCorr = "corr-pay-sql-7f3a9c";
    const payStack = [
      "at Microsoft.Data.SqlClient.SqlCommand.ExecuteReader()",
      "at Payments.Api.Infrastructure.LedgerRepository.GetOpenAuthorization(Guid paymentId) in /src/Payments.Api/Infrastructure/LedgerRepository.cs:line 84",
      "at Payments.Api.Services.CaptureService.CaptureAsync(CaptureRequest request) in /src/Payments.Api/Services/CaptureService.cs:line 51",
      "at Payments.Api.Controllers.PaymentsController.Capture(CaptureRequest request) in /src/Payments.Api/Controllers/PaymentsController.cs:line 118",
    ];
    events.push(
      makeEvent(minutesAgo(now, 4.9, Math.floor(rand() * 400)), {
        eventId: "seed-pay-sql-begin",
        level: "info",
        service: "Payments.Api",
        host: "pay-prod-2",
        environment: "Production",
        msg: "Capture requested for open authorization",
        correlationId: payCorr,
        paymentId: "pay_9f2c1a",
        requestPath: "/v1/payments/capture",
      }),
    );
    for (let i = 0; i < 12; i += 1) {
      events.push(
        makeEvent(minutesAgo(now, 4.7 - i * 0.04, Math.floor(rand() * 200)), {
          eventId: `seed-pay-sql-error-${i}`,
          level: "error",
          service: "Payments.Api",
          host: i % 2 === 0 ? "pay-prod-2" : "pay-prod-1",
          environment: "Production",
          msg: "Timeout expired. The timeout period elapsed prior to completion of the operation or the server is not responding.",
          exceptionType: "Microsoft.Data.SqlClient.SqlException",
          failureMode: "database-timeout",
          scenario: "payments-sql-timeout",
          correlationId: payCorr,
          paymentId: "pay_9f2c1a",
          commandTimeoutSeconds: 30,
          database: "PaymentsLedger",
          stack: payStack,
        }),
      );
    }
    events.push(
      makeEvent(minutesAgo(now, 4.1), {
        eventId: "seed-pay-sql-warn",
        level: "warn",
        service: "Payments.Api",
        host: "pay-prod-2",
        environment: "Production",
        msg: "Capture retry 3 of 5 deferred after SqlException",
        correlationId: payCorr,
        exceptionType: "Microsoft.Data.SqlClient.SqlException",
        failureMode: "database-timeout",
      }),
    );

    const ordCorr = "corr-ord-http-2b18e4";
    const ordStack = [
      "at System.Net.Http.HttpClient.HandleFailureStatusCode(HttpResponseMessage response)",
      "at Orders.Api.Clients.PaymentsClient.CaptureAsync(CaptureRequest request) in /src/Orders.Api/Clients/PaymentsClient.cs:line 64",
      "at Orders.Api.Services.CheckoutService.PlaceOrder(PlaceOrderRequest request) in /src/Orders.Api/Services/CheckoutService.cs:line 141",
      "at Orders.Api.Controllers.CheckoutController.Place(PlaceOrderRequest request) in /src/Orders.Api/Controllers/CheckoutController.cs:line 88",
    ];
    events.push(
      makeEvent(minutesAgo(now, 4.65), {
        eventId: "seed-ord-http-begin",
        level: "info",
        service: "Orders.Api",
        host: "ord-prod-1",
        environment: "Production",
        msg: "Placing order; capturing payment",
        correlationId: ordCorr,
        orderId: "ord_44190",
        dependency: "Payments.Api",
      }),
    );
    for (let i = 0; i < 8; i += 1) {
      events.push(
        makeEvent(minutesAgo(now, 4.55 - i * 0.03, Math.floor(rand() * 120)), {
          eventId: `seed-ord-http-error-${i}`,
          level: "error",
          service: "Orders.Api",
          host: "ord-prod-1",
          environment: "Production",
          msg: "Payment capture failed: HTTP 504 from Payments.Api after 8000ms",
          exceptionType: "System.Net.Http.HttpRequestException",
          failureMode: "http-integration",
          scenario: "orders-http-payments",
          correlationId: ordCorr,
          orderId: "ord_44190",
          statusCode: 504,
          dependency: "Payments.Api",
          upstreamCorrelationId: payCorr,
          stack: ordStack,
        }),
      );
    }

    const nullCorr = "corr-ord-null-91aa02";
    const nullStack = [
      "at Orders.Api.Domain.ShippingAddress.get_PostalCode() in /src/Orders.Api/Domain/ShippingAddress.cs:line 41",
      "at Orders.Api.Services.CheckoutService.QuoteShipping(Cart cart) in /src/Orders.Api/Services/CheckoutService.cs:line 96",
      "at Orders.Api.Controllers.CheckoutController.Quote(QuoteRequest request) in /src/Orders.Api/Controllers/CheckoutController.cs:line 70",
    ];
    events.push(
      makeEvent(minutesAgo(now, 3.2, Math.floor(rand() * 80)), {
        eventId: "seed-ord-null-info",
        level: "info",
        service: "Orders.Api",
        host: "ord-prod-2",
        environment: "Production",
        msg: "Shipping quote requested",
        correlationId: nullCorr,
        cartId: "cart_17b",
      }),
    );
    for (let i = 0; i < 3; i += 1) {
      events.push(
        makeEvent(minutesAgo(now, 3.15 - i * 0.02), {
          eventId: `seed-ord-null-error-${i}`,
          level: "error",
          service: "Orders.Api",
          host: "ord-prod-2",
          environment: "Production",
          msg: "Object reference not set to an instance of an object.",
          exceptionType: "System.NullReferenceException",
          failureMode: "null-reference",
          scenario: "orders-null-shipping",
          correlationId: nullCorr,
          cartId: "cart_17b",
          member: "ShippingAddress.PostalCode",
          stack: nullStack,
        }),
      );
    }

    const cfgCorr = "corr-cust-cfg-c0ffee";
    const cfgStack = [
      "at Microsoft.Extensions.DependencyInjection.ServiceLookup.CallSiteRuntimeResolver.VisitConstructor(RuntimeResolverContext context)",
      "at Customer.Api.Infrastructure.CustomerDbContext..ctor(IConfiguration configuration) in /src/Customer.Api/Infrastructure/CustomerDbContext.cs:line 22",
      "at Customer.Api.Services.ProfileService.GetProfile(Guid customerId) in /src/Customer.Api/Services/ProfileService.cs:line 33",
      "at Customer.Api.Controllers.ProfileController.Get(Guid id) in /src/Customer.Api/Controllers/ProfileController.cs:line 29",
    ];
    events.push(
      makeEvent(minutesAgo(now, 11.2, Math.floor(rand() * 40)), {
        eventId: "seed-cust-cfg-warn",
        level: "warn",
        service: "Customer.Api",
        host: "cust-stg-1",
        environment: "Staging",
        msg: "Configuration value ConnectionStrings:CustomerDb was not found",
        correlationId: cfgCorr,
        configKey: "ConnectionStrings:CustomerDb",
      }),
    );
    for (let i = 0; i < 5; i += 1) {
      events.push(
        makeEvent(minutesAgo(now, 11.1 - i * 0.05), {
          eventId: `seed-cust-cfg-error-${i}`,
          level: "error",
          service: "Customer.Api",
          host: "cust-stg-1",
          environment: "Staging",
          msg: "Unable to resolve service for type 'Customer.Api.Infrastructure.CustomerDbContext' while attempting to activate 'ProfileService'.",
          exceptionType: "System.InvalidOperationException",
          failureMode: "di-config",
          scenario: "customer-missing-connection-string",
          correlationId: cfgCorr,
          configKey: "ConnectionStrings:CustomerDb",
          stack: cfgStack,
        }),
      );
    }

    const efCorr = "corr-inv-ef-44b1d0";
    const efStack = [
      "at Microsoft.EntityFrameworkCore.Storage.RelationalConnection.OpenInternal(Boolean errorsExpected)",
      "at Inventory.Api.Data.StockRepository.FindLowStockAsync(Int32 warehouseId) in /src/Inventory.Api/Data/StockRepository.cs:line 112",
      "at Inventory.Api.Services.ReplenishmentService.ScanAsync() in /src/Inventory.Api/Services/ReplenishmentService.cs:line 58",
    ];
    events.push(
      makeEvent(minutesAgo(now, 6.4, Math.floor(rand() * 90)), {
        eventId: "seed-inv-ef-warn",
        level: "warn",
        service: "Inventory.Api",
        host: "inv-prod-1",
        environment: "Production",
        msg: "EF Core query FindLowStockAsync exceeded 2s (Include warehouses.bins.skus)",
        correlationId: efCorr,
        queryMs: 2140,
        query: "FindLowStockAsync",
      }),
    );
    for (let i = 0; i < 4; i += 1) {
      events.push(
        makeEvent(minutesAgo(now, 6.2 - i * 0.04), {
          eventId: `seed-inv-ef-error-${i}`,
          level: "error",
          service: "Inventory.Api",
          host: "inv-prod-1",
          environment: "Production",
          msg: "An exception occurred while iterating over the results of a query for context type 'InventoryDbContext'.",
          exceptionType: "Microsoft.EntityFrameworkCore.DbUpdateException",
          failureMode: "ef-core-query",
          scenario: "inventory-ef-low-stock",
          correlationId: efCorr,
          query: "FindLowStockAsync",
          warehouseId: 12,
          stack: efStack,
        }),
      );
    }

    const asmCorr = "corr-inv-asm-d3adc0";
    const asmStack = [
      "at System.Runtime.Loader.AssemblyLoadContext.LoadFromAssemblyName(AssemblyName assemblyName)",
      "at Inventory.Api.Integrations.ContractLoader.Load() in /src/Inventory.Api/Integrations/ContractLoader.cs:line 19",
      "at Inventory.Api.Workers.CatalogSyncWorker.ExecuteAsync(CancellationToken stoppingToken) in /src/Inventory.Api/Workers/CatalogSyncWorker.cs:line 47",
    ];
    events.push(
      makeEvent(minutesAgo(now, 9.1, Math.floor(rand() * 30)), {
        eventId: "seed-inv-asm-info",
        level: "info",
        service: "Inventory.Api",
        host: "inv-stg-1",
        environment: "Staging",
        msg: "Catalog sync worker starting",
        correlationId: asmCorr,
      }),
    );
    for (let i = 0; i < 2; i += 1) {
      events.push(
        makeEvent(minutesAgo(now, 9.05 - i * 0.03), {
          eventId: `seed-inv-asm-error-${i}`,
          level: "error",
          service: "Inventory.Api",
          host: "inv-stg-1",
          environment: "Staging",
          msg: "Could not load file or assembly 'Inventory.Contracts, Version=2.4.0.0'. The system cannot find the file specified.",
          exceptionType: "System.IO.FileNotFoundException",
          failureMode: "assembly-load",
          scenario: "inventory-missing-contracts",
          correlationId: asmCorr,
          assembly: "Inventory.Contracts, Version=2.4.0.0",
          stack: asmStack,
        }),
      );
    }

    const slowCorr = "corr-rpt-slow-0a11e5";
    const slowStack = [
      "at Reporting.Worker.Clients.WarehouseClient.QueryFactsAsync(DateOnly day) in /src/Reporting.Worker/Clients/WarehouseClient.cs:line 73",
      "at Reporting.Worker.Jobs.DailySalesJob.RunAsync(CancellationToken cancellationToken) in /src/Reporting.Worker/Jobs/DailySalesJob.cs:line 36",
    ];
    events.push(
      makeEvent(minutesAgo(now, 12.4, Math.floor(rand() * 50)), {
        eventId: "seed-rpt-slow-warn",
        level: "warn",
        service: "Reporting.Worker",
        host: "rpt-prod-1",
        environment: "Production",
        msg: "WarehouseClient.QueryFactsAsync still running after 15000ms",
        correlationId: slowCorr,
        dependency: "warehouse-analytics",
        elapsedMs: 15000,
      }),
    );
    for (let i = 0; i < 3; i += 1) {
      events.push(
        makeEvent(minutesAgo(now, 12.1 - i * 0.06), {
          eventId: `seed-rpt-slow-error-${i}`,
          level: "error",
          service: "Reporting.Worker",
          host: "rpt-prod-1",
          environment: "Production",
          msg: "The operation has timed out.",
          exceptionType: "System.TimeoutException",
          failureMode: "slow-dependency",
          scenario: "reporting-warehouse-timeout",
          correlationId: slowCorr,
          dependency: "warehouse-analytics",
          timeoutMs: 20000,
          stack: slowStack,
        }),
      );
    }

    const authCorr = "corr-pay-auth-55e881";
    const authStack = [
      "at Microsoft.AspNetCore.Authentication.JwtBearer.JwtBearerHandler.HandleAuthenticateAsync()",
      "at Payments.Api.Security.MerchantContext.RequireActiveSession() in /src/Payments.Api/Security/MerchantContext.cs:line 28",
      "at Payments.Api.Controllers.PayoutsController.Create(PayoutRequest request) in /src/Payments.Api/Controllers/PayoutsController.cs:line 44",
    ];
    events.push(
      makeEvent(minutesAgo(now, 2.4, Math.floor(rand() * 20)), {
        eventId: "seed-pay-auth-warn",
        level: "warn",
        service: "Payments.Api",
        host: "pay-prod-1",
        environment: "Production",
        msg: "JWT expired for merchant session",
        correlationId: authCorr,
        merchantId: "mch_204",
      }),
    );
    for (let i = 0; i < 4; i += 1) {
      events.push(
        makeEvent(minutesAgo(now, 2.3 - i * 0.03), {
          eventId: `seed-pay-auth-error-${i}`,
          level: "error",
          service: "Payments.Api",
          host: "pay-prod-1",
          environment: "Production",
          msg: "Attempted to perform an unauthorized operation.",
          exceptionType: "System.UnauthorizedAccessException",
          failureMode: "auth-session",
          scenario: "payments-expired-session",
          correlationId: authCorr,
          merchantId: "mch_204",
          requestPath: "/v1/payouts",
          stack: authStack,
        }),
      );
    }

    for (let i = 0; i < 8; i += 1) {
      events.push(
        makeEvent(minutesAgo(now, 8 - i * 0.2, Math.floor(rand() * 80)), {
          eventId: `seed-dev-fill-${String(i).padStart(2, "0")}`,
          level: "info",
          service: "Orders.Api",
          host: "ord-dev-1",
          environment: "Development",
          msg: pick(rand, INFO["Orders.Api"]),
          requestId: `req_dev_${String(i).padStart(2, "0")}`,
        }),
      );
    }

    events.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
    return events;
  }

  function parseQuery(input) {
    const text = [];
    const fields = {};
    const re = /(-)?(?:([A-Za-z_][\w.-]*):(?:"([^"]*)"|(\S+))|"([^"]+)"|(\S+))/g;
    let match;
    while ((match = re.exec(input.trim()))) {
      const negate = Boolean(match[1]);
      const fieldName = match[2];
      const value = (match[3] ?? match[4] ?? match[5] ?? match[6] ?? "").trim();
      if (!value) continue;
      if (fieldName) {
        const key = fieldName.toLowerCase();
        const bucket = (fields[key] ??= { include: [], exclude: [] });
        (negate ? bucket.exclude : bucket.include).push(value.toLowerCase());
      } else if (negate) {
        const bucket = (fields.message ??= { include: [], exclude: [] });
        bucket.exclude.push(value.toLowerCase());
      } else {
        text.push(value.toLowerCase());
      }
    }
    return { text, fields };
  }

  function eventField(event, key) {
    switch (key) {
      case "level":
      case "lvl":
      case "severity":
        return event.level;
      case "source":
      case "service":
      case "_source":
        return event.source;
      case "host":
      case "hostname":
        return event.host;
      case "message":
      case "msg":
        return event.message;
      case "environment":
      case "env":
        return event.environment ?? field(event, [key]);
      case "exceptiontype":
      case "exception_type":
      case "exception":
        return event.exceptionType ?? field(event, [key]);
      case "correlationid":
      case "correlation_id":
      case "traceid":
      case "trace_id":
        return event.correlationId ?? field(event, [key]);
      default:
        return field(event, [key]);
    }
  }

  function matchesQuery(event, query) {
    for (const term of query.text) {
      const blob = `${event.message} ${event.raw} ${event.source} ${event.host}`;
      if (!blob.toLowerCase().includes(term)) return false;
    }
    for (const [key, { include, exclude }] of Object.entries(query.fields)) {
      const value = eventField(event, key);
      if (include.length > 0 && !include.some((item) => value?.toLowerCase().includes(item))) return false;
      if (exclude.some((item) => value?.toLowerCase().includes(item))) return false;
    }
    return true;
  }

  function timeWindow() {
    if (state.windowOverride) return state.windowOverride;
    return { from: state.now - rangeMs(state.range), to: state.now + 60_000 };
  }

  function inRange(event, from, to, query) {
    if (event.timestamp < from || event.timestamp > to) return false;
    if (state.sources.length && !state.sources.includes(event.source)) return false;
    if (state.levels.length && !state.levels.includes(event.level)) return false;
    if (state.environments.length && (!event.environment || !state.environments.includes(event.environment))) return false;
    if (state.exceptionTypes.length && (!event.exceptionType || !state.exceptionTypes.includes(event.exceptionType))) {
      return false;
    }
    return matchesQuery(event, query);
  }

  function filtered() {
    const query = parseQuery(state.query);
    const { from, to } = timeWindow();
    return state.events.filter((event) => inRange(event, from, to, query)).sort((a, b) => b.timestamp - a.timestamp);
  }

  function statsFor(matched) {
    const { from, to } = timeWindow();
    const bucketCount = 48;
    const span = Math.max(to - from, 1);
    const width = span / bucketCount;
    const histogram = Array.from({ length: bucketCount }, (_, i) => ({
      start: from + i * width,
      end: from + (i + 1) * width,
      count: 0,
      errorCount: 0,
      warnCount: 0,
    }));
    const byLevel = Object.fromEntries(LEVELS.map((level) => [level, 0]));
    const sourceCounts = new Map();
    const sourceErrors = new Map();
    const hostCounts = new Map();
    const environmentCounts = new Map();
    const exceptionCounts = new Map();
    const sourceErrorEnvs = new Map();

    for (const event of matched) {
      byLevel[event.level] += 1;
      sourceCounts.set(event.source, (sourceCounts.get(event.source) ?? 0) + 1);
      hostCounts.set(event.host, (hostCounts.get(event.host) ?? 0) + 1);
      if (event.level === "error" || event.level === "fatal") {
        sourceErrors.set(event.source, (sourceErrors.get(event.source) ?? 0) + 1);
        if (event.environment) {
          const set = sourceErrorEnvs.get(event.source) ?? new Set();
          set.add(event.environment);
          sourceErrorEnvs.set(event.source, set);
        }
      }
      if (event.environment) {
        const env = environmentCounts.get(event.environment) ?? { name: event.environment, count: 0, errorCount: 0 };
        env.count += 1;
        if (event.level === "error" || event.level === "fatal") env.errorCount += 1;
        environmentCounts.set(event.environment, env);
      }
      if (event.exceptionType) {
        exceptionCounts.set(event.exceptionType, (exceptionCounts.get(event.exceptionType) ?? 0) + 1);
      }
      const index = Math.min(bucketCount - 1, Math.max(0, Math.floor((event.timestamp - from) / width)));
      const bucket = histogram[index];
      bucket.count += 1;
      if (event.level === "error" || event.level === "fatal") bucket.errorCount += 1;
      if (event.level === "warn") bucket.warnCount += 1;
    }

    const applications = APPS.map((name) => {
      const count = sourceCounts.get(name) ?? 0;
      const errorCount = sourceErrors.get(name) ?? 0;
      return {
        name,
        count,
        errorCount,
        environments: [...(sourceErrorEnvs.get(name) ?? [])].sort(),
        status: healthStatus(errorCount, count),
      };
    })
      .filter((app) => app.count > 0)
      .sort((a, b) => b.errorCount - a.errorCount || b.count - a.count);

    return {
      matched: matched.length,
      total: state.events.length,
      byLevel,
      bySource: APPS.map((name) => ({ name, count: sourceCounts.get(name) ?? 0 })),
      byHost: [...hostCounts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      byEnvironment: [...environmentCounts.values()].sort((a, b) => b.count - a.count),
      byExceptionType: [...exceptionCounts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      applications,
      histogram,
    };
  }

  function contextFor(event) {
    const related = new Map([[event.id, event]]);
    if (event.correlationId) {
      for (const item of state.events) {
        if (item.correlationId === event.correlationId) related.set(item.id, item);
      }
    }
    for (const item of state.events) {
      if (Math.abs(item.timestamp - event.timestamp) <= 30_000 && item.source === event.source) {
        related.set(item.id, item);
      }
    }
    return [...related.values()].sort((a, b) => a.timestamp - b.timestamp).slice(0, 24);
  }

  function collectEvidence(event, context) {
    const evidence = [`${event.level.toUpperCase()} from ${event.source} on ${event.host}: ${event.message}`];
    if (event.environment) evidence.push(`Environment: ${event.environment}`);
    if (event.exceptionType) evidence.push(`Exception type: ${event.exceptionType}`);
    if (event.correlationId) evidence.push(`Correlation id: ${event.correlationId}`);
    const dependency = field(event, ["dependency"]);
    if (dependency) evidence.push(`Dependency: ${dependency}`);
    const configKey = field(event, ["configKey"]);
    if (configKey) evidence.push(`Configuration key: ${configKey}`);
    const query = field(event, ["query"]);
    if (query) evidence.push(`Query: ${query}`);
    const assembly = field(event, ["assembly"]);
    if (assembly) evidence.push(`Assembly: ${assembly}`);
    const member = field(event, ["member"]);
    if (member) evidence.push(`Member: ${member}`);
    const statusCode = field(event, ["statusCode"]);
    if (statusCode) evidence.push(`HTTP status: ${statusCode}`);
    const upstream = field(event, ["upstreamCorrelationId"]);
    if (upstream) evidence.push(`Upstream correlation id: ${upstream}`);
    if (event.stackFrames?.length) evidence.push(`Stack frames: ${event.stackFrames.slice(0, 4).join(" → ")}`);
    const related = context.filter((item) => item.id !== event.id);
    if (related.length) {
      const sources = [...new Set(related.map((item) => item.source))];
      evidence.push(`${related.length} related event(s) in the selected window` + (sources.length ? ` from ${sources.join(", ")}` : ""));
    }
    return evidence;
  }

  function analyzeEvent(event, context) {
    const evidence = collectEvidence(event, context);
    const key = field(event, ["failureMode"]) ?? field(event, ["scenario"]);
    const cached = key ? CACHED[key] : undefined;
    if (cached) return { ...cached(event), evidence, provider: "cached" };
    return {
      summary: `${event.source} logged ${event.level} on ${event.host}: ${event.message}`,
      likelyFailureArea: event.exceptionType
        ? `Code path throwing ${event.exceptionType} in ${event.source}.`
        : `The ${event.source} service on ${event.host}.`,
      evidence,
      likelyCause:
        evidence.length > 1
          ? "Insufficient structured evidence to name a precise root cause beyond the logged message and fields."
          : "Only the log message is available; no exception type, stack, or correlation id was present.",
      recommendedInvestigation: [
        event.correlationId
          ? `Search for correlation id ${event.correlationId} across services.`
          : "Search neighboring events on the same host and timestamp.",
        event.stackFrames?.length
          ? "Start at the first application frame in the stack (not the framework frame)."
          : "Capture a stack or exception type on the next occurrence.",
      ],
      confidence: "Low",
      limitations: ["No cached diagnostic matched this event.", "The analyzer did not call an LLM and will not invent missing telemetry."],
      provider: "heuristic",
    };
  }

  function toggle(list, value) {
    return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  }
  function hasSession() {
    return sessionStorage.getItem(SESSION_KEY) === "1";
  }
  function enterDemo() {
    sessionStorage.setItem(SESSION_KEY, "1");
    showApp();
  }
  function showApp() {
    document.body.classList.add("demo-open");
    document.getElementById("landing").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    state.events = buildCatalog(Date.now());
    state.now = Date.now();
    render();
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function render() {
    const matched = filtered();
    const stats = statsFor(matched);
    const selected = matched.find((event) => event.id === state.selectedId) ?? null;
    if (state.selectedId && !selected) {
      state.selectedId = null;
      state.analysis = null;
    }

    renderHealth(stats);
    renderFilters(stats);
    renderSearch();
    renderHistogram(stats);
    document.getElementById("match-meta").innerHTML = `${stats.matched.toLocaleString()} matching · ${stats.total.toLocaleString()} stored`;
    renderRows(matched.slice(0, 500));
    const inspectorEvent =
      selected ?? (state.selectedId ? state.events.find((event) => event.id === state.selectedId) : null);
    renderInspector(inspectorEvent);
    document.body.classList.toggle("inspector-open", Boolean(inspectorEvent));
    document.body.classList.toggle("filters-open", state.sidebarOpen);
    document.getElementById("sidebar").classList.toggle("open", state.sidebarOpen);
    document.getElementById("scrim").classList.toggle("hidden", !state.sidebarOpen);
    document.getElementById("about-dialog").classList.toggle("hidden", !state.aboutOpen);
    document.getElementById("live-switch").classList.toggle("on", state.live);
    document.getElementById("live-switch").setAttribute("aria-checked", String(state.live));
    const tourBar = document.getElementById("tour-bar");
    const playHeader = document.getElementById("play-demo-header");
    const pauseBtn = document.getElementById("tour-pause");
    if (state.tour === "idle") {
      tourBar.classList.add("hidden");
      playHeader.classList.remove("hidden");
    } else {
      tourBar.classList.remove("hidden");
      playHeader.classList.add("hidden");
      document.getElementById("tour-caption").textContent = TOUR_STEPS[state.tourStep]?.caption ?? TOUR_STEPS[TOUR_STEPS.length - 1].caption;
      pauseBtn.textContent = state.tour === "paused" ? "Resume" : "Pause";
    }
  }

  function renderHealth(stats) {
    const root = document.getElementById("health-grid");
    root.innerHTML = stats.applications
      .map(
        (app) => `
        <button type="button" class="health-card ${state.sources.includes(app.name) ? "active" : ""}" data-source="${escapeHtml(app.name)}">
          <div class="health-top">
            <p class="name">${escapeHtml(app.name)}</p>
            <span class="status status-${app.status}">${app.status[0].toUpperCase()}${app.status.slice(1)}</span>
          </div>
          <p class="health-meta">${app.errorCount} errors · ${app.count.toLocaleString()} events</p>
          ${app.environments.length ? `<p class="health-envs">${escapeHtml(app.environments.join(" · "))}</p>` : ""}
        </button>`,
      )
      .join("");
    document.getElementById("env-chips").innerHTML = stats.byEnvironment
      .map(
        (env) => `
        <button type="button" class="env-chip ${state.environments.includes(env.name) ? "active" : ""}" data-env="${escapeHtml(env.name)}">
          ${escapeHtml(env.name)}<span class="count">${env.errorCount} err</span>
        </button>`,
      )
      .join("");
  }

  function renderFilters(stats) {
    const sourceRoot = document.getElementById("filter-sources");
    sourceRoot.innerHTML = stats.bySource
      .map(
        (source) => `
        <button type="button" class="filter-row ${state.sources.includes(source.name) ? "active" : ""}" data-source="${escapeHtml(source.name)}">
          <span>${escapeHtml(source.name)}</span><span class="count">${source.count}</span>
        </button>`,
      )
      .join("");
    document.getElementById("filter-envs").innerHTML = stats.byEnvironment.length
      ? stats.byEnvironment
          .map(
            (env) => `
          <button type="button" class="filter-row ${state.environments.includes(env.name) ? "active" : ""}" data-env="${escapeHtml(env.name)}">
            <span>${escapeHtml(env.name)}</span><span class="count">${env.count}</span>
          </button>`,
          )
          .join("")
      : `<p class="empty-note">No environment labels.</p>`;
    document.getElementById("filter-levels").innerHTML = LEVELS.map(
      (level) => `
        <button type="button" class="filter-row ${state.levels.includes(level) ? "active" : ""}" data-level="${level}">
          <span class="dot dot-${level}"></span><span>${level}</span><span class="count">${stats.byLevel[level] ?? 0}</span>
        </button>`,
    ).join("");
    document.getElementById("filter-exceptions").innerHTML = stats.byExceptionType.length
      ? stats.byExceptionType
          .map(
            (item) => `
          <button type="button" class="filter-row ${state.exceptionTypes.includes(item.name) ? "active" : ""}" data-exception="${escapeHtml(item.name)}">
            <span>${escapeHtml(item.name.split(".").pop())}</span><span class="count">${item.count}</span>
          </button>`,
          )
          .join("")
      : `<p class="empty-note">No exceptions in this window.</p>`;
    document.getElementById("filter-hosts").innerHTML = stats.byHost
      .slice(0, 8)
      .map(
        (host) => `
        <div class="host-row"><span>${escapeHtml(host.name)}</span><span class="count">${host.count}</span></div>`,
      )
      .join("");
  }

  function renderSearch() {
    const input = document.getElementById("search");
    if (document.activeElement !== input) input.value = state.draft;
    document.getElementById("ranges").innerHTML = RANGES.map(
      (item) =>
        `<button type="button" class="${item.id === state.range && !state.windowOverride ? "active" : ""}" data-range="${item.id}">${item.label}</button>`,
    ).join("");
    document.getElementById("clear-brush").classList.toggle("hidden", !state.windowOverride);
  }

  function renderHistogram(stats) {
    const max = Math.max(1, ...stats.histogram.map((bucket) => bucket.count));
    const first = stats.histogram[0];
    const last = stats.histogram[stats.histogram.length - 1];
    document.getElementById("histogram-bars").innerHTML = stats.histogram
      .map((bucket, index) => {
        const height = (bucket.count / max) * 100;
        const errors = (bucket.errorCount / max) * 100;
        const warns = (bucket.warnCount / max) * 100;
        return `<button type="button" data-bucket="${index}" title="${bucket.count} events · ${formatClock(bucket.start)}">
          <span class="bar" style="height:${height}%"></span>
          <span class="bar-warn" style="height:${warns}%"></span>
          <span class="bar-error" style="height:${errors}%"></span>
          ${bucket.count === 0 ? '<span class="bar-empty"></span>' : ""}
        </button>`;
      })
      .join("");
    document.getElementById("hist-start").textContent = first ? formatClock(first.start) : "";
    document.getElementById("hist-end").textContent = last ? formatClock(last.end) : "";
  }

  function renderRows(events) {
    const root = document.getElementById("stream");
    if (!events.length) {
      root.innerHTML = `<div class="empty-state"><strong>No logs in this window</strong><p>Clear a filter or widen the time range to see the seeded services.</p></div>`;
      return;
    }
    root.innerHTML = events
      .map(
        (event) => `
        <button type="button" class="log-row level-${event.level} ${state.selectedId === event.id ? "selected" : ""}" data-id="${escapeHtml(event.id)}" id="log-${escapeHtml(event.id)}">
          <span class="time">${formatClock(event.timestamp)}</span>
          <span class="lvl lvl-${event.level}">${event.level}</span>
          <span class="src">${escapeHtml(event.source)}</span>
          <span class="msg"><span class="mobile-src">${escapeHtml(event.source)}</span>${escapeHtml(event.message)}</span>
        </button>`,
      )
      .join("");
  }

  function renderInspector(event) {
    const root = document.getElementById("inspector");
    if (!event) {
      root.classList.add("hidden");
      root.innerHTML = "";
      return;
    }
    const context = contextFor(event);
    const canAnalyze = event.level === "error" || event.level === "fatal" || Boolean(event.exceptionType);
    const skip = new Set([
      "stack",
      "stackTrace",
      "stack_trace",
      "stackFrames",
      "environment",
      "env",
      "exceptionType",
      "exception",
      "correlationId",
      "correlation_id",
    ]);
    const fieldEntries = Object.entries(event.fields).filter(([key]) => !skip.has(key));
    const tab = state.inspectorTab;
    let body = "";
    if (tab === "details") {
      body = `
        <p class="message">${escapeHtml(event.message)}</p>
        <dl>
          <div class="field"><dt>timestamp</dt><dd>${iso(event.timestamp)}</dd></div>
          <div class="field"><dt>level</dt><dd>${escapeHtml(event.level)}</dd></div>
          ${event.environment ? `<div class="field"><dt>environment</dt><dd>${escapeHtml(event.environment)}</dd></div>` : ""}
          ${event.correlationId ? `<div class="field"><dt>correlation id</dt><dd>${escapeHtml(event.correlationId)}</dd></div>` : ""}
          ${event.exceptionType ? `<div class="field"><dt>exception</dt><dd>${escapeHtml(event.exceptionType)}</dd></div>` : ""}
          ${fieldEntries.map(([key, value]) => `<div class="field"><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}
        </dl>
        ${
          event.stackFrames?.length
            ? `<p class="caps">Stack frames</p><ol class="stack">${event.stackFrames.map((frame) => `<li>${escapeHtml(frame)}</li>`).join("")}</ol>`
            : ""
        }
        <pre class="raw">${escapeHtml(event.raw)}</pre>`;
    } else if (tab === "context") {
      body = context.length
        ? context
            .map(
              (item) => `
            <div class="ctx-item ${item.id === event.id ? "current" : ""}">
              <p class="when">${formatStamp(item.timestamp)} · ${escapeHtml(item.source)} · ${escapeHtml(item.level)}</p>
              <p class="body">${escapeHtml(item.message)}</p>
            </div>`,
            )
            .join("")
        : `<p>No surrounding events for this correlation window.</p>`;
    } else {
      const analysis = state.analysis;
      body = analysis
        ? `<div class="analysis">
            <section><h3>Summary</h3><p>${escapeHtml(analysis.summary)}</p></section>
            <section><h3>Likely failure area</h3><p>${escapeHtml(analysis.likelyFailureArea)}</p></section>
            <section><h3>Evidence</h3><ul>${analysis.evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>
            <section><h3>Likely cause</h3><p>${escapeHtml(analysis.likelyCause)}</p></section>
            <section><h3>Recommended investigation</h3><ul>${analysis.recommendedInvestigation.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>
            <section><h3>Confidence / limitations</h3><p>${escapeHtml(analysis.confidence)}</p>
              <ul class="limits">${analysis.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
            </section>
          </div>`
        : `<p>Run Analyze with AI to generate diagnostic sections from this event's evidence.</p>`;
    }
    root.classList.remove("hidden");
    root.innerHTML = `
      <div class="inspector-head">
        <div>
          <p class="src">${escapeHtml(event.source)}</p>
          <p class="host">${escapeHtml(event.host)}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-xs" id="close-inspector" aria-label="Close inspector">✕</button>
      </div>
      <div class="inspector-tabs">
        <button type="button" data-tab="details" class="${tab === "details" ? "active" : ""}">Details</button>
        <button type="button" data-tab="context" class="${tab === "context" ? "active" : ""}">Context</button>
        <button type="button" data-tab="analysis" class="${tab === "analysis" ? "active" : ""}">Analysis</button>
      </div>
      <div class="inspector-body">${body}</div>
      ${
        canAnalyze
          ? `<div class="inspector-foot">
              <button type="button" class="btn btn-primary btn-full" id="analyze-btn" ${state.analyzing ? "disabled" : ""}>
                ${state.analyzing ? "Analyzing…" : "Analyze with AI"}
              </button>
            </div>`
          : ""
      }`;
  }

  function pickTourEvent(events) {
    return (
      events.find(
        (event) =>
          event.source === "Payments.Api" &&
          event.level === "error" &&
          ((event.fields.failureMode ?? event.fields.scenario) === "database-timeout" ||
            event.message.toLowerCase().includes("timeout expired")),
      ) ??
      events.find((event) => event.level === "error") ??
      events[0]
    );
  }

  function interruptTour() {
    if (state.tourDriving) return;
    if (state.tour !== "idle") stopTour();
  }

  function stopTour() {
    window.clearTimeout(state.tourTimer);
    state.tourTimer = null;
    state.tour = "idle";
  }

  function resetDemoView() {
    state.draft = "";
    state.query = "";
    state.range = "1h";
    state.live = false;
    state.sources = [];
    state.levels = [];
    state.environments = [];
    state.exceptionTypes = [];
    state.windowOverride = null;
    state.selectedId = null;
    state.inspectorTab = "details";
    state.analysis = null;
    state.analyzing = false;
  }

  function applyTourStep(id) {
    if (id === "overview") {
      resetDemoView();
      return;
    }
    if (id === "filter") {
      state.sources = ["Payments.Api"];
      state.levels = [];
      state.environments = [];
      state.exceptionTypes = [];
      state.selectedId = null;
      state.analysis = null;
      return;
    }
    const target = pickTourEvent(filtered());
    if (!target) return;
    state.sources = ["Payments.Api"];
    state.selectedId = target.id;
    if (id === "context") state.inspectorTab = "context";
    else if (id === "analyze" || id === "done") state.inspectorTab = "analysis";
    else state.inspectorTab = "details";
    if (id === "analyze") {
      state.analysis = analyzeEvent(target, contextFor(target));
      state.analyzing = false;
    }
    requestAnimationFrame(() => {
      document.getElementById(`log-${target.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  function scheduleTour() {
    window.clearTimeout(state.tourTimer);
    if (state.tour !== "playing") return;
    const step = TOUR_STEPS[state.tourStep];
    if (!step) {
      state.tour = "idle";
      render();
      return;
    }
    state.tourDriving = true;
    applyTourStep(step.id);
    state.tourDriving = false;
    render();
    state.tourTimer = window.setTimeout(() => {
      state.tourStep += 1;
      scheduleTour();
    }, step.ms);
  }

  function startTour() {
    window.clearTimeout(state.tourTimer);
    resetDemoView();
    state.tour = "playing";
    state.tourStep = 0;
    scheduleTour();
  }

  function playFromLanding() {
    sessionStorage.setItem(SESSION_KEY, "1");
    showApp();
    startTour();
  }

  function bind() {
    document.getElementById("enter-demo").addEventListener("click", enterDemo);
    document.getElementById("play-demo").addEventListener("click", playFromLanding);
    document.getElementById("play-demo-header").addEventListener("click", startTour);
    document.getElementById("tour-pause").addEventListener("click", () => {
      if (state.tour === "paused") {
        state.tour = "playing";
        scheduleTour();
      } else if (state.tour === "playing") {
        window.clearTimeout(state.tourTimer);
        state.tour = "paused";
        render();
      }
    });
    document.getElementById("tour-stop").addEventListener("click", () => {
      stopTour();
      render();
    });
    document.getElementById("search-form").addEventListener("submit", (event) => {
      event.preventDefault();
      state.query = state.draft.trim();
      state.now = Date.now();
      render();
    });
    document.getElementById("search").addEventListener("input", (event) => {
      state.draft = event.target.value;
    });
    let searchTimer;
    document.getElementById("search").addEventListener("input", (event) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.query = event.target.value.trim();
        render();
      }, 350);
    });
    document.getElementById("ranges").addEventListener("click", (event) => {
      const button = event.target.closest("[data-range]");
      if (!button) return;
      state.range = button.dataset.range;
      state.windowOverride = null;
      state.now = Date.now();
      interruptTour();
      render();
    });
    document.getElementById("clear-brush").addEventListener("click", () => {
      interruptTour();
      state.windowOverride = null;
      render();
    });
    document.getElementById("live-switch").addEventListener("click", () => {
      interruptTour();
      state.live = !state.live;
      if (state.live) {
        state.windowOverride = null;
        state.now = Date.now();
      }
      render();
    });
    document.getElementById("histogram-bars").addEventListener("click", (event) => {
      const button = event.target.closest("[data-bucket]");
      if (!button) return;
      const matched = filtered();
      const stats = statsFor(matched);
      const bucket = stats.histogram[Number(button.dataset.bucket)];
      if (!bucket) return;
      interruptTour();
      state.live = false;
      state.windowOverride = { from: bucket.start, to: bucket.end };
      render();
    });
    document.getElementById("health-grid").addEventListener("click", (event) => {
      const button = event.target.closest("[data-source]");
      if (!button) return;
      interruptTour();
      state.sources = toggle(state.sources, button.dataset.source);
      render();
    });
    document.getElementById("env-chips").addEventListener("click", (event) => {
      const button = event.target.closest("[data-env]");
      if (!button) return;
      interruptTour();
      state.environments = toggle(state.environments, button.dataset.env);
      render();
    });
    document.getElementById("sidebar").addEventListener("click", (event) => {
      const source = event.target.closest("[data-source]");
      const env = event.target.closest("[data-env]");
      const level = event.target.closest("[data-level]");
      const exception = event.target.closest("[data-exception]");
      if (source) state.sources = toggle(state.sources, source.dataset.source);
      else if (env) state.environments = toggle(state.environments, env.dataset.env);
      else if (level) state.levels = toggle(state.levels, level.dataset.level);
      else if (exception) state.exceptionTypes = toggle(state.exceptionTypes, exception.dataset.exception);
      else return;
      interruptTour();
      render();
    });
    document.getElementById("stream").addEventListener("click", (event) => {
      const row = event.target.closest("[data-id]");
      if (!row) return;
      interruptTour();
      state.selectedId = row.dataset.id;
      state.inspectorTab = "details";
      state.analysis = null;
      render();
    });
    document.getElementById("inspector").addEventListener("click", (event) => {
      if (event.target.closest("#close-inspector")) {
        interruptTour();
        state.selectedId = null;
        state.analysis = null;
        render();
        return;
      }
      const tab = event.target.closest("[data-tab]");
      if (tab) {
        interruptTour();
        state.inspectorTab = tab.dataset.tab;
        render();
        return;
      }
      if (event.target.closest("#analyze-btn")) {
        interruptTour();
        const selected = state.events.find((item) => item.id === state.selectedId);
        if (!selected) return;
        state.analyzing = true;
        render();
        window.setTimeout(() => {
          state.analysis = analyzeEvent(selected, contextFor(selected));
          state.analyzing = false;
          state.inspectorTab = "analysis";
          render();
        }, 280);
      }
    });
    document.getElementById("about-open").addEventListener("click", () => {
      state.aboutOpen = true;
      render();
    });
    document.getElementById("about-close").addEventListener("click", () => {
      state.aboutOpen = false;
      render();
    });
    document.getElementById("about-dialog").addEventListener("click", (event) => {
      if (event.target.id === "about-dialog") {
        state.aboutOpen = false;
        render();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !state.aboutOpen) return;
      state.aboutOpen = false;
      render();
    });
    document.getElementById("filters-btn").addEventListener("click", () => {
      state.sidebarOpen = true;
      render();
    });
    document.getElementById("sidebar-close").addEventListener("click", () => {
      state.sidebarOpen = false;
      render();
    });
    document.getElementById("scrim").addEventListener("click", () => {
      state.sidebarOpen = false;
      render();
    });
    setInterval(() => {
      if (!state.live) return;
      state.now = Date.now();
      render();
    }, 8000);
  }

  bind();
  if (hasSession()) showApp();
})();
