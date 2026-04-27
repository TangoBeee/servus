// @ts-nocheck
export class BrowserCoreAPIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class BrowserCoreAPIUnauthorizedError extends BrowserCoreAPIError {
  constructor(message?: string) {
    super(message || "Unauthorized request");
  }
}

export class BrowserCoreHttpError extends BrowserCoreAPIError {
  constructor(message: string) {
    super(message);
  }
}

export class BrowserCoreServerError extends BrowserCoreAPIError {
  constructor(message: string) {
    super(message);
  }
}

export class BrowserCoreResponseBodyError extends BrowserCoreAPIError {
  constructor() {
    super("Response body is null");
  }
}

export class BrowserCoreResponseParseError extends BrowserCoreAPIError {
  constructor(message: string) {
    super(message);
  }
}
