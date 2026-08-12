/**
 * Express 4 does not forward a rejected promise from an async handler to the
 * error middleware; without this wrapper a thrown AppError becomes a hung
 * request instead of a response.
 */
export const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);
