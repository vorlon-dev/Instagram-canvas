const createError = require('http-errors');
const { CustomError } = require('../lib/errors');

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  console.log(err.message) // eslint-disable-line no-console
  // if the error is safe to expose to client
  if (err instanceof CustomError || err instanceof createError.HttpError) {
    res.status(err.status || 500).send({ message: err.message });
  } else {
    // Include the underlying cause so failures can be diagnosed from the
    // response itself (this is a small private service, not a public API).
    res.status(500).send({
      message: 'Internal Server Error',
      detail: err && err.message ? err.message : String(err),
    });
  }
};


module.exports = errorHandler;
