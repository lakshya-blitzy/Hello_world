const http = require('http');

const hostname = '127.0.0.1';
const port = 3000;

// --- Robustness bounds -------------------------------------------------------
// Each runtime value below was an *implicit* default the code never stated, which
// is why wire behaviour could shift between Node versions with no change here.
// The four are pinned to exactly what the runtime already applied, so the wire
// contract is unchanged; they are now explicit and adjustable in one place. The
// MAX_*, SOCKET_IDLE and SHUTDOWN_GRACE values are new bounds closing the
// unbounded-input, unbounded-stalled-request and unbounded-shutdown defects, and
// FATAL_FLUSH bounds the wait for a fatal record to reach a stalled stderr.
const HEADERS_TIMEOUT_MS = 60000;    // time allowed to receive complete headers
const REQUEST_TIMEOUT_MS = 300000;   // time allowed to receive the entire request
const KEEP_ALIVE_TIMEOUT_MS = 5000;  // idle time allowed after a response
// Incomplete requests are reaped by a periodic checker rather than a per-socket
// timer, so this interval is the enforcement granularity of the two timeouts above.
const CONNECTIONS_CHECK_MS = 30000;
const MAX_URL_LENGTH = 2048;         // request target longer than this -> 414
const MAX_BODY_BYTES = 1048576;      // request body larger than this -> 413
const SOCKET_IDLE_MS = 120000;       // socket inactivity bound; 0, the default, means none
const SHUTDOWN_GRACE_MS = 10000;     // in-flight drain window before a forced close
const FATAL_FLUSH_MS = 2000;         // longest wait for a fatal record to reach stderr

const ALLOWED_METHODS = ['GET', 'HEAD'];
const BODY = 'Hello, World!\n';

// Tracks live sockets so shutdown can destroy them on runtimes that predate
// server.closeAllConnections() (added v18.2.0).
const sockets = new Set();
let shuttingDown = false;
let forcedClose = false; // set when the grace deadline fires, so the exit code stays 1
let hadError = false;    // a server 'error' event must not be erased by a later clean close
let fatalRecorded = false; // one fatal sequence per process, however many events arrive

// Request targets reach the log, so they are reduced to the path, stripped of
// control characters and truncated. Query strings never appear: they can carry
// caller-supplied secrets, and the pre-fix server logged no request data at all.
function logTarget(req) {
  const raw = String(req.url || '').split('?')[0];
  return raw.replace(/[^\x20-\x7e]/g, '.').slice(0, 80);
}

// Writes an error response without ever assuming the response is still usable.
// Blind-writing here is fatal: after headers flush, setHeader() throws
// ERR_HTTP_HEADERS_SENT and a second end() raises ERR_STREAM_WRITE_AFTER_END as
// an unhandled 'error' event, which kills the process.
function sendError(res, status, extraHeaders) {
  if (res.headersSent || res.writableEnded || res.destroyed) {
    res.destroy();
    return;
  }
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Connection', 'close');
  for (const [name, value] of Object.entries(extraHeaders || {})) {
    res.setHeader(name, value);
  }
  res.end(`${status} ${http.STATUS_CODES[status]}\n`);
}

// Releases a socket the server has finished with, without discarding anything it
// still owes the client. destroySoon() ends the write side once the queued bytes
// have flushed and destroys it afterwards; destroy() drops them where they stand.
// It is the same call the runtime uses to close a 'Connection: close' socket, and
// it is a no-op on a socket that is already gone, so callers may repeat it.
function releaseSocket(socket) {
  if (!socket || socket.destroyed) {
    return;
  }
  if (typeof socket.destroySoon === 'function') {
    socket.destroySoon();
  } else {
    socket.destroy();
  }
}

// Releases the socket behind a request the server will not read any further, once
// that request's response has actually been written. 'finish' is the point at
// which the last byte has been handed to the operating system; 'close' covers a
// response that ended without finishing because the connection had already
// failed. Releasing any earlier discards the response itself.
function releaseAfterResponse(req, res) {
  const socket = req.socket;
  if (res.writableFinished) {
    releaseSocket(socket);
    return;
  }
  res.once('finish', () => releaseSocket(socket));
  res.once('close', () => releaseSocket(socket));
}

// Refuses a payload over MAX_BODY_BYTES, for both the declared-length and the
// streamed path, so the two cannot drift apart. Inbound flow is stopped rather
// than torn down: destroying the request destroys its socket in the same tick --
// measured, the response's own 'finish' then reports the socket already destroyed
// -- so a 413 still in the write buffer is discarded and the client is reset
// instead of answered. pause() stops pulling in a payload that has already been
// refused, and TCP back-pressure stops the sender from making progress, while the
// 'Connection: close' that sendError() sets tells the client this socket is
// finished with. The socket itself goes only once the 413 has left the process.
function refusePayload(req, res) {
  req.pause();
  sendError(res, 413);
  releaseAfterResponse(req, res);
}

// Rejects a request whose *declared* body size exceeds MAX_BODY_BYTES. A streamed
// body declares no size, so the handler enforces the same cap by counting bytes
// as they arrive; both paths refuse through refusePayload(), which is what keeps
// the two responses identical. Returning true means the request has been answered
// and must not be served.
function bodyExceedsLimit(req, res) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    refusePayload(req, res);
    return true;
  }
  return false;
}

// The original three response statements, unchanged, in one place so both the
// immediate and the deferred path write an identical response. Content-Length is
// deliberately not set, so HEAD keeps omitting it.
function respondSuccess(req, res) {
  try {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end(BODY);
  } catch (err) {
    // Reachable from the deferred path, which the handler's catch cannot see.
    console.error(`error completing ${req.method} ${logTarget(req)}: ${err.stack || err}`);
    sendError(res, 500);
  }
}

const server = http.createServer({ connectionsCheckingInterval: CONNECTIONS_CHECK_MS }, (req, res) => {
  try {
    // Surface stream failures instead of letting them reach the event loop.
    req.on('error', (err) => console.error(`request stream error: ${err.code || err.message}`));
    res.on('error', (err) => console.error(`response stream error: ${err.code || err.message}`));

    // Marks this socket as serving a request for as long as the response is open,
    // so shutdown can drain it rather than destroying it as idle. The reference is
    // captured once: the response detaches from the socket when it completes, and
    // the accounting below still has to name the socket it was counting.
    const socket = req.socket;
    socket.activeRequests = (socket.activeRequests || 0) + 1;
    let accounted = true;
    res.on('close', () => {
      if (!accounted) return; // exactly one decrement per request, never two
      accounted = false;
      socket.activeRequests = Math.max(0, (socket.activeRequests || 1) - 1);
      // A socket that falls idle *during* a drain has to be released right here.
      // The sweep in shutdown() is a snapshot taken before server.close(), and
      // close() keeps an established socket rather than closing it, so a request
      // that finishes after the sweep would otherwise hold the drain open until
      // the grace deadline forced it -- measured: exit 1 for work that completed
      // with three quarters of the window still to run. By 'close' the response
      // has already flushed, so releasing the socket cannot truncate it.
      if (shuttingDown && !socket.activeRequests) {
        releaseSocket(socket);
      }
    });

    if (shuttingDown) {
      sendError(res, 503);
      return;
    }

    // --- Input validation (the request object was previously never read) ---
    if (!ALLOWED_METHODS.includes(req.method)) {
      // RFC 9110 s15.5.6 and s10.2.1: a 405 response MUST carry an Allow header.
      sendError(res, 405, { Allow: ALLOWED_METHODS.join(', ') });
      return;
    }
    if (req.url.length > MAX_URL_LENGTH) {
      sendError(res, 414);
      return;
    }

    // Only an origin-form target is served. An authority-bearing target
    // ('//admin', 'http://evil.example/') and a non-canonical one ('/admin/..',
    // '/%2e%2e/') both normalise to pathname '/' under new URL(), which would
    // serve the root resource for a target that never named it. The raw target
    // is therefore checked before any normalisation can erase the difference.
    if (req.url.charAt(0) !== '/' || req.url.charAt(1) === '/') {
      sendError(res, 400);
      return;
    }
    const rawPath = req.url.split('?')[0];
    try {
      // decodeURIComponent throws URIError on a malformed escape such as '/%ZZ'.
      // Only the path is decoded; the query string is not interpreted at all, and
      // is therefore neither validated nor rejected -- it is opaque by design.
      decodeURIComponent(rawPath);
    } catch (err) {
      sendError(res, 400);
      return;
    }
    if (rawPath !== '/') {
      sendError(res, 404);
      return;
    }
    if (bodyExceedsLimit(req, res)) return;

    // Only a body of UNKNOWN length forces the response to wait. A declared
    // Content-Length was already checked against the cap above, so such a request
    // cannot exceed it and is answered immediately -- exactly as before the fix,
    // including when the declared body never fully arrives.
    if (req.headers['transfer-encoding'] === undefined) {
      req.resume();
      respondSuccess(req, res);
      return;
    }

    // A chunked body has no declared size, so the cap can only be enforced by
    // counting as it streams, and the success response must wait for the count.
    // Committing it earlier let an oversized chunked body receive the full
    // greeting and only then have its socket reset -- a 200 for a payload the
    // server had already decided to refuse.
    let received = 0;
    let answered = false;
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES && !answered) {
        answered = true;
        // The same refusal the declared-length path takes. `answered` makes every
        // later 'data' chunk and the 'end' event below no-ops, so the refused
        // request is never also served, and the paused stream stops pulling in
        // the rest of a payload this response has already rejected.
        refusePayload(req, res);
      }
    });
    req.on('end', () => {
      if (answered) return;
      answered = true;
      // Same helper as the immediate path, so both write an identical response
      // and both route a late failure through one place.
      respondSuccess(req, res);
    });
    req.resume(); // explicit drain; flows the body and triggers 'end'
  } catch (err) {
    // Previously any throw here terminated the process and took the service down
    // for every client. It now becomes a 500 for the one failing request.
    console.error(`unhandled error serving ${req.method} ${logTarget(req)}: ${err.stack || err}`);
    sendError(res, 500);
  }
});

// Protocol-level failures the parser rejects before a request object exists.
// Attaching this listener removes Node's default 400/431 reply, so the mapping is
// reimplemented here -- otherwise those responses silently become dropped sockets.
server.on('clientError', (err, socket) => {
  // One socket can raise a second event after the first is answered -- a request
  // timeout is followed by HPE_INVALID_EOF_STATE on the same socket -- so without
  // this guard one rejection produces two diagnostics and a write to a closed socket.
  if (socket.protocolErrorHandled) {
    // The reply the first event queued has to survive this one. destroy() drops
    // whatever is still in the write buffer, which would truncate that reply, so
    // the socket is released only once it has finished writing; before then this
    // event does nothing at all, because the end() below has already closed the
    // write side and is the thing that finishes the exchange.
    if (socket.writableFinished) socket.destroy();
    return;
  }
  socket.protocolErrorHandled = true;
  console.error(`client protocol error: ${err.code || err.message} (bytesParsed=${err.bytesParsed})`);
  if (err.code === 'ECONNRESET' || !socket.writable) {
    socket.destroy();
    return;
  }
  // Each of these statuses is one the runtime would have sent itself; attaching
  // this listener suppressed all of them, so the mapping is reproduced here.
  let status = 400;
  if (err.code === 'HPE_HEADER_OVERFLOW') status = 431;
  else if (err.code === 'ERR_HTTP_REQUEST_TIMEOUT') status = 408;
  // Framing matches Node's own default reply byte for byte -- status line plus
  // Connection: close and nothing else -- so the wire form is preserved exactly.
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`);
});

// Bind failures previously surfaced as an unhandled 'error' event: a raw
// node:events stack trace and exit 1 with no readiness line and no diagnosis.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Cannot start: ${hostname}:${port} is already in use. Stop the process holding it or choose another port.`);
  } else if (err.code === 'EACCES') {
    console.error(`Cannot start: permission denied binding ${hostname}:${port}.`);
  } else {
    console.error(`Server error: ${err.stack || err}`);
  }
  // exitCode rather than exit(): if the listener never bound the loop is already
  // empty and the process leaves with 1 once stderr has flushed.
  hadError = true;
  process.exitCode = 1;
  // A post-listen error is different: the listener is still open, so nothing would
  // end the process and it would serve on in a failed state. Drain and stop.
  if (server.listening) shutdown('server error');
});

// Per-socket request accounting. Shutdown needs to distinguish a socket that is
// serving a request from one that is merely open: server.close() waits for both,
// so without this an accepted socket that never sent a byte would hold the drain
// open until the grace deadline and turn a clean stop into a forced one.
server.on('connection', (socket) => {
  socket.activeRequests = 0;
  // A connection that arrives once the drain has begun is released at once and
  // never tracked. It carries no request by definition, the sweep that releases
  // idle sockets has already run, and server.close() stops accepting without
  // closing what is already established -- so retaining it could only hold the
  // shutdown open for a client the server has no intention of serving.
  if (shuttingDown) {
    releaseSocket(socket);
    return;
  }
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

// Pin the connection lifecycle bounds (see the constants above).
server.headersTimeout = HEADERS_TIMEOUT_MS;
server.requestTimeout = REQUEST_TIMEOUT_MS;
server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
// The one state nothing else bounds: a request that reached the handler and then
// stopped sending. requestTimeout does not reap it (measured open past 15s with this
// line removed); a socket that sends nothing is bounded by headersTimeout instead.
server.timeout = SOCKET_IDLE_MS;

// Installing a signal listener removes Node's default exit, so this handler is
// now solely responsible for terminating the process -- hence the forced deadline.
function shutdown(signal) {
  if (shuttingDown) return; // absorb repeat and mixed signals
  shuttingDown = true;
  console.log(`Received ${signal}, draining ${sockets.size} connection(s)`);

  const forced = setTimeout(() => {
    console.error(`Shutdown grace period of ${SHUTDOWN_GRACE_MS}ms expired, forcing close`);
    forcedClose = true;
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    } else {
      for (const socket of sockets) socket.destroy();
    }
    process.exitCode = 1;
  }, SHUTDOWN_GRACE_MS);
  forced.unref(); // must never be the reason the loop stays alive

  // Sockets with no request in progress are released immediately. This is what
  // server.closeIdleConnections() is for, but on Node 18.2.0 that call also
  // destroys in-flight requests (measured), so the same job is done explicitly
  // from the per-socket counter, which cannot misclassify. releaseSocket() rather
  // than destroy(): a socket with no request in progress can still owe the client
  // a protocol-error reply, and that reply is flushed before the socket goes.
  for (const socket of sockets) {
    if (!socket.activeRequests) releaseSocket(socket);
  }

  server.close((err) => {
    clearTimeout(forced);
    if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
      console.error(`Error during shutdown: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    console.log('Server closed');
    // exitCode rather than exit(): process.exit() can truncate a pending
    // stdout write when stdout is a pipe, which would lose this very line.
    // A forced close, or an earlier server error, must not be reported as a clean
    // stop -- this callback would otherwise reset either code to 0.
    process.exitCode = (forcedClose || hadError) ? 1 : 0;
  });

}

// Records a fatal condition and terminates with 1. Writing the record with
// console.error() and then calling process.exit(1) is not enough: a supervisor
// gives this process a pipe for stderr, writes to a pipe complete
// asynchronously, and process.exit() abandons whatever has not drained --
// measured, a stack larger than the 64 KiB pipe buffer arrived truncated, losing
// the only account of why the process died. So the record is written through the
// stream's own completion callback and the exit happens from there.
function fatal(message) {
  if (fatalRecorded) return; // a second fatal event must not restart this sequence
  fatalRecorded = true;
  // Set before anything can go wrong below, so that an event loop which empties
  // while the write is still in flight still leaves with a failure code.
  process.exitCode = 1;

  // The process state is undefined from here on, so nothing more is accepted or
  // served: an abandoned half-written response is worse than a closed connection.
  if (!shuttingDown) {
    shuttingDown = true;
    server.close();
  }
  for (const socket of sockets) socket.destroy();

  // A stderr that never drains -- a full pipe with no reader, or a stream already
  // in an error state -- must not turn a fatal exit into a hang. unref() keeps
  // this deadline from being the reason the process stays alive.
  const deadline = setTimeout(() => process.exit(1), FATAL_FLUSH_MS);
  deadline.unref();
  // If stderr fails outright there is nowhere left to report it, and the only
  // remaining obligation is the exit code.
  process.stderr.once('error', () => process.exit(1));
  process.stderr.write(`${message}\n`, () => {
    clearTimeout(deadline);
    process.exit(1);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Last resort only: the process is in an undefined state, so record it and exit.
process.on('uncaughtException', (err, origin) => {
  fatal(`Fatal: uncaught exception (origin=${origin}): ${err.stack || err}`);
});
process.on('unhandledRejection', (reason) => {
  fatal(`Fatal: unhandled promise rejection: ${reason instanceof Error ? reason.stack : reason}`);
});

server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});
