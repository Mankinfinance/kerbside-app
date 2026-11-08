export class PaymentDeclinedError extends Error {
  constructor(message = 'The card was declined. Try another card.', code = 'CARD_DECLINED') {
    super(message);
    this.code = code;
  }
}

export class GatewayError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
