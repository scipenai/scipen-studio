export class GatewayError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'GatewayError';
    this.statusCode = Number(options.statusCode ?? 500);
    this.code = options.code ?? null;
  }
}

export function toGatewayError(error, fallbackMessage = 'Internal server error') {
  if (error instanceof GatewayError) {
    return error;
  }
  const message = error instanceof Error ? error.message : fallbackMessage;
  const wrapped = new GatewayError(message, {
    statusCode: Number(error?.statusCode ?? 500),
    code: error?.code ?? null,
  });
  wrapped.cause = error;
  return wrapped;
}
