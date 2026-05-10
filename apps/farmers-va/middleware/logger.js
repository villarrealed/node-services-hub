/**
 * logger.js
 * 
 * Request logging middleware combining morgan and custom timing logger.
 */

import morgan from 'morgan';

/**
 * Custom timing logger middleware
 */
export function timingLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${req.method}] ${req.url} ${res.statusCode} ${duration}ms`);
  });

  next();
}

/**
 * Combined logger middleware (morgan + timing)
 */
export function createLogger() {
  return [morgan('combined'), timingLogger];
}
