// Generated from contract/api/openbalance.openapi.yaml by scripts/generate-api-types.mjs. Do not edit by hand.
export type Address = string;
export type Health = {
  status: string;
  service: string;
};
export type Readiness = {
  status: "ready" | "not_ready";
  checks?: Array<{
    name?: string;
    status?: string;
  }>;
};
export type Error = {
  error: string;
  action?: string;
  retryable?: boolean;
};
export type Session = {
  account: Address;
  sessionToken: string;
};
export type EnrollmentSubmission = {
  token: string;
  response: Record<string, unknown>;
};
export type ActivityItem = {
  transitionId: string;
  kind: string;
  aggregateKind: "PAYMENT" | "CHANNEL";
  aggregateId: string;
  transactionHash: string;
  blockNumber: string;
  blockHash: string;
};
export type Activity = {
  items: Array<ActivityItem>;
  nextCursor?: unknown | null;
};
export type FaucetGrant = {
  transactionHash: string;
  amount: string;
  account: Address;
};
export type ReserveChannel = {
  channelId: string;
  eventId: string;
  status: "ACTIVE" | "RECLAIMED";
  remainingUnits: string;
  submitUntil: string;
};
export type CheckoutOrderRequest = {
  orderReference: string;
  orderVersion: string;
  description: string;
  grossUnits: string;
};
export type CheckoutOrder = {
  created: boolean;
};

export type Schemas = {
  Address: Address;
  Health: Health;
  Readiness: Readiness;
  Error: Error;
  Session: Session;
  EnrollmentSubmission: EnrollmentSubmission;
  ActivityItem: ActivityItem;
  Activity: Activity;
  FaucetGrant: FaucetGrant;
  ReserveChannel: ReserveChannel;
  CheckoutOrderRequest: CheckoutOrderRequest;
  CheckoutOrder: CheckoutOrder;
};

export type Operations = {
  healthLive: {
    method: "GET";
    path: "/health/live";
    parameters: {};
    requestBody: never;
    responses: {
      "200": Health;
    };
  };
  healthReady: {
    method: "GET";
    path: "/health/ready";
    parameters: {};
    requestBody: never;
    responses: {
      "200": Readiness;
      "503": Readiness;
    };
  };
  createEnrollmentChallenge: {
    method: "POST";
    path: "/v1/accounts/enrollment-challenges";
    parameters: {};
    requestBody: never;
    responses: {
      "200": Record<string, unknown>;
    };
  };
  registerPasskey: {
    method: "POST";
    path: "/v1/accounts/enrollment/register";
    parameters: {};
    requestBody: EnrollmentSubmission;
    responses: {
      "200": Record<string, unknown>;
      "400": Error;
    };
  };
  createAuthenticationChallenge: {
    method: "POST";
    path: "/v1/accounts/authentication-challenges";
    parameters: {};
    requestBody: {
      account: Address;
    };
    responses: {
      "200": Record<string, unknown>;
      "403": Error;
    };
  };
  authenticatePasskey: {
    method: "POST";
    path: "/v1/accounts/authentications";
    parameters: {};
    requestBody: {
      challengeToken: string;
      response: Record<string, unknown>;
    };
    responses: {
      "200": Session;
      "403": Error;
    };
  };
  readAccount: {
    method: "GET";
    path: "/v1/accounts/me";
    parameters: {};
    requestBody: never;
    responses: {
      "200": Record<string, unknown>;
      "401": Error;
    };
  };
  readAccountActivity: {
    method: "GET";
    path: "/v1/accounts/me/activity";
    parameters: {
      "query:limit"?: number;
      "query:beforeBlock"?: string;
      "query:beforeTransitionId"?: string;
    };
    requestBody: never;
    responses: {
      "200": Activity;
      "401": Error;
    };
  };
  fundTestBalance: {
    method: "POST";
    path: "/v1/funding/faucet";
    parameters: {};
    requestBody: {
      amount: string;
    };
    responses: {
      "200": FaucetGrant;
      "401": Error;
      "422": Error;
      "429": Error;
      "503": Error;
    };
  };
  readPaymentIntent: {
    method: "GET";
    path: "/v1/payment-intents/{id}";
    parameters: {
      "path:id": string;
    };
    requestBody: never;
    responses: {
      "200": Record<string, unknown>;
      "401": Error;
      "404": Error;
    };
  };
  readReserveChannel: {
    method: "GET";
    path: "/v1/reserve-channels/{id}";
    parameters: {
      "path:id": string;
    };
    requestBody: never;
    responses: {
      "200": ReserveChannel;
      "401": Error;
      "404": Error;
    };
  };
  createCheckoutOrder: {
    method: "POST";
    path: "/v1/checkout-orders";
    parameters: {
      "header:Idempotency-Key": string;
    };
    requestBody: CheckoutOrderRequest;
    responses: {
      "200": CheckoutOrder;
      "201": CheckoutOrder;
      "409": Error;
      "422": Error;
    };
  };
};

export type Paths = {
  "/health/live": {
    get: {
      method: "GET";
      path: "/health/live";
      parameters: {};
      requestBody: never;
      responses: {
        "200": Health;
      };
    };
  };
  "/health/ready": {
    get: {
      method: "GET";
      path: "/health/ready";
      parameters: {};
      requestBody: never;
      responses: {
        "200": Readiness;
        "503": Readiness;
      };
    };
  };
  "/v1/accounts/enrollment-challenges": {
    post: {
      method: "POST";
      path: "/v1/accounts/enrollment-challenges";
      parameters: {};
      requestBody: never;
      responses: {
        "200": Record<string, unknown>;
      };
    };
  };
  "/v1/accounts/enrollment/register": {
    post: {
      method: "POST";
      path: "/v1/accounts/enrollment/register";
      parameters: {};
      requestBody: EnrollmentSubmission;
      responses: {
        "200": Record<string, unknown>;
        "400": Error;
      };
    };
  };
  "/v1/accounts/authentication-challenges": {
    post: {
      method: "POST";
      path: "/v1/accounts/authentication-challenges";
      parameters: {};
      requestBody: {
        account: Address;
      };
      responses: {
        "200": Record<string, unknown>;
        "403": Error;
      };
    };
  };
  "/v1/accounts/authentications": {
    post: {
      method: "POST";
      path: "/v1/accounts/authentications";
      parameters: {};
      requestBody: {
        challengeToken: string;
        response: Record<string, unknown>;
      };
      responses: {
        "200": Session;
        "403": Error;
      };
    };
  };
  "/v1/accounts/me": {
    get: {
      method: "GET";
      path: "/v1/accounts/me";
      parameters: {};
      requestBody: never;
      responses: {
        "200": Record<string, unknown>;
        "401": Error;
      };
    };
  };
  "/v1/accounts/me/activity": {
    get: {
      method: "GET";
      path: "/v1/accounts/me/activity";
      parameters: {
        "query:limit"?: number;
        "query:beforeBlock"?: string;
        "query:beforeTransitionId"?: string;
      };
      requestBody: never;
      responses: {
        "200": Activity;
        "401": Error;
      };
    };
  };
  "/v1/funding/faucet": {
    post: {
      method: "POST";
      path: "/v1/funding/faucet";
      parameters: {};
      requestBody: {
        amount: string;
      };
      responses: {
        "200": FaucetGrant;
        "401": Error;
        "422": Error;
        "429": Error;
        "503": Error;
      };
    };
  };
  "/v1/payment-intents/{id}": {
    get: {
      method: "GET";
      path: "/v1/payment-intents/{id}";
      parameters: {
        "path:id": string;
      };
      requestBody: never;
      responses: {
        "200": Record<string, unknown>;
        "401": Error;
        "404": Error;
      };
    };
  };
  "/v1/reserve-channels/{id}": {
    get: {
      method: "GET";
      path: "/v1/reserve-channels/{id}";
      parameters: {
        "path:id": string;
      };
      requestBody: never;
      responses: {
        "200": ReserveChannel;
        "401": Error;
        "404": Error;
      };
    };
  };
  "/v1/checkout-orders": {
    post: {
      method: "POST";
      path: "/v1/checkout-orders";
      parameters: {
        "header:Idempotency-Key": string;
      };
      requestBody: CheckoutOrderRequest;
      responses: {
        "200": CheckoutOrder;
        "201": CheckoutOrder;
        "409": Error;
        "422": Error;
      };
    };
  };
};
