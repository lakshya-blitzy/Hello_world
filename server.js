const http = require('http');

const hostname = '127.0.0.1';
const port = 3000;

// --- Robustness bounds -------------------------------------------------------
// Each runtime value below was an *implicit* default the code never stated, which
// is why wire behaviour could shift between Node versions with no change here.
// The four are pinned to exactly what the runtime already applied, so the wire
// contract is unchanged; they are now explicit and adjustable in one place. The
// MAX_*, SOCKET_IDLE, SHUTDOWN_GRACE and FATAL_FLUSH values are new bounds closing
// the unbounded-input, unbounded-stalled-request, unbounded-shutdown and
// unbounded-fatal-flush defects.
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
// A fatal record has to reach stderr before the process leaves, but waiting for a
// stream that will never drain would turn the fatal path into a hang, so the wait
// is bounded. See fatal() for why the wait exists at all.
const FATAL_FLUSH_MS = 1000;         // longest wait for a fatal record to flush

const ALLOWED_METHODS = ['GET', 'HEAD'];
const BODY = 'Hello, World!\n';

// Tracks live sockets so shutdown can destroy them on runtimes that predate
// server.closeAllConnections() (added v18.2.0).
const sockets = new Set();
let shuttingDown = false;
let forcedClose = false; // set when the grace deadline fires, so the exit code stays 1
let hadError = false;    // a server 'error' event must not be erased by a later clean close
let fatalHandled = false; // one fatal sequence per process, whichever handler arrives first

// --- Failure-detail formatting -----------------------------------------------
// A diagnostic is written while something has already gone wrong, so nothing in
// producing it may itself fail, and nothing it carries may be trusted.
//
// A thrown or rejected value can be any value at all. `throw null` makes a bare
// `err.stack` read throw TypeError; a Symbol cannot be interpolated into a
// template at all; an object can carry a `stack` getter, a `toString()` or a
// Proxy trap that throws, and a revoked Proxy throws on every access. Any of
// those turns the diagnostic into a second, worse failure: in the request path it
// escapes the handler's catch before the 500 is written, killing the process for
// every client, and inside a process-level handler it is not caught again at all,
// so the only record of the original failure disappears.
//
// The same value is also hostile data. CR/LF would let one caught value end its
// record and forge another that reads like a lifecycle line; ESC and its friends
// would let it drive an operator's terminal; and a custom toString() can emit
// megabytes from a single event.
//
// Every failure detail therefore passes through the helpers below, which are
// total: whatever they are handed, they return a bounded, printable string.
const DETAIL_MAX_CHARS = 2048;   // cap on one formatted detail, before prefixes
const DETAIL_MAX_LINES = 12;     // stack lines kept; the default trace is 11
const LABEL_MAX_CHARS = 200;     // cap on a one-line code-or-message label
const CONTINUATION_PREFIX = '  | ';
const TRUNCATION_MARKER = '...<truncated>';
const UNPRINTABLE_DETAIL = '<unprintable error>';

// Reads one property without ever propagating a failure: the property may be a
// getter that throws, and a revoked Proxy throws on every access.
function safeRead(value, name) {
  try {
    return value[name];
  } catch (readError) {
    return undefined;
  }
}

// Total conversion to a primitive string. String() rather than interpolation,
// because interpolating a Symbol throws where String() is defined for it.
function safeString(value) {
  try {
    return typeof value === 'string' ? value : String(value);
  } catch (conversionError) {
    // A throwing toString()/valueOf()/Symbol.toPrimitive, or a revoked Proxy.
    return UNPRINTABLE_DETAIL;
  }
}

// Drops every byte outside printable ASCII, which is the same policy logTarget()
// applies to a request path. This is what stops a detail carrying ESC or any
// other control byte into a terminal.
function printableOnly(text) {
  return text.replace(/[^\x20-\x7e]/g, '.');
}

// Collapses a value onto exactly one bounded line. CR and LF are escaped rather
// than dropped, so the text stays readable while losing its ability to end this
// record and start a forged one.
function onOneLine(text, limit) {
  const flattened = printableOnly(text.replace(/\r/g, '\\r').replace(/\n/g, '\\n'));
  const bounded = flattened.length > limit
    ? `${flattened.slice(0, limit)}${TRUNCATION_MARKER}`
    : flattened;
  return bounded === '' ? UNPRINTABLE_DETAIL : bounded;
}

// One-line rendering of a single field that is not itself an error: a parser byte
// count, a fatal handler's origin.
function safeValue(value) {
  return onOneLine(safeString(value), LABEL_MAX_CHARS);
}

// One-line rendering of an error's short identity: its code, else its message,
// else the value itself. The total form of the `err.code || err.message` idiom.
function safeLabel(err) {
  const code = safeRead(err, 'code');
  if (typeof code === 'string' && code !== '') {
    return safeValue(code);
  }
  if (typeof code === 'number') {
    return safeValue(code);
  }
  const message = safeRead(err, 'message');
  if (typeof message === 'string' && message !== '') {
    return safeValue(message);
  }
  return safeValue(err);
}

// Full detail for a thrown or rejected value. A native multi-line stack is kept,
// because it is the only thing that locates the failure, but every line after the
// first is prefixed so that none of them can be read as a new top-level record,
// and both the line count and the character count are bounded. Any other value
// has no trusted shape, so it is collapsed onto a single line instead.
function safeDetail(value) {
  const stack = safeRead(value, 'stack');
  if (typeof stack !== 'string' || stack === '') {
    return onOneLine(safeString(value), DETAIL_MAX_CHARS);
  }
  const bounded = stack.length > DETAIL_MAX_CHARS
    ? `${stack.slice(0, DETAIL_MAX_CHARS)}${TRUNCATION_MARKER}`
    : stack;
  const lines = bounded.split(/\r\n|\r|\n/);
  const kept = lines.slice(0, DETAIL_MAX_LINES);
  let record = printableOnly(kept[0]);
  for (let i = 1; i < kept.length; i += 1) {
    record += `\n${CONTINUATION_PREFIX}${printableOnly(kept[i])}`;
  }
  if (lines.length > kept.length) {
    record += `\n${CONTINUATION_PREFIX}${TRUNCATION_MARKER}`;
  }
  return record;
}

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

// Rejects a request whose declared or streamed body exceeds MAX_BODY_BYTES.
// Returning true means the request has been answered and must not be served.
function bodyExceedsLimit(req, res) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    sendError(res, 413);
    req.destroy(); // do not drain a payload we have already refused
    return true;
  }
  return false;
}

// The original three response statements, unchanged, in one place so both the
// immediate and the deferred path write an identical response. Content-Length is
// deliberately not set, so HEAD keeps omitting it.
function respondSuccess(req, res) {
  try {
    // A request dispatched before a fatal event still holds a deferred completion
    // callback that nothing else cancels, so without this it would answer 200 out
    // of an undefined process state during the fatal flush window -- measured.
    // fatal() destroys the connections as well; this is the application-level half
    // of the same cutoff, and it is the one that keeps the intent local to the
    // write it prevents. Normal operation never reaches it: only fatal() ever sets
    // the flag, and it exits the process immediately afterwards.
    if (fatalHandled) {
      res.destroy();
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end(BODY);
  } catch (err) {
    // Reachable from the deferred path, which the handler's catch cannot see.
    console.error(`error completing ${req.method} ${logTarget(req)}: ${safeDetail(err)}`);
    sendError(res, 500);
  }
}

const server = http.createServer({ connectionsCheckingInterval: CONNECTIONS_CHECK_MS }, (req, res) => {
  try {
    // Surface stream failures instead of letting them reach the event loop.
    req.on('error', (err) => console.error(`request stream error: ${safeLabel(err)}`));
    res.on('error', (err) => console.error(`response stream error: ${safeLabel(err)}`));

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
        sendError(res, 413);
        req.destroy(); // do not drain a payload we have already refused
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
    // for every client. It now becomes a 500 for the one failing request -- which
    // holds for any thrown value, because formatting the detail cannot itself
    // throw and so cannot jump past the sendError() below.
    console.error(`unhandled error serving ${req.method} ${logTarget(req)}: ${safeDetail(err)}`);
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
  // The parser owns this error, but the value still arrives as an object whose
  // properties are read here, so it is read the same guarded way as any other.
  const code = safeRead(err, 'code');
  console.error(`client protocol error: ${safeLabel(err)} (bytesParsed=${safeValue(safeRead(err, 'bytesParsed'))})`);
  if (code === 'ECONNRESET' || !socket.writable) {
    socket.destroy();
    return;
  }
  // Each of these statuses is one the runtime would have sent itself; attaching
  // this listener suppressed all of them, so the mapping is reproduced here.
  let status = 400;
  if (code === 'HPE_HEADER_OVERFLOW') status = 431;
  else if (code === 'ERR_HTTP_REQUEST_TIMEOUT') status = 408;
  // Framing matches Node's own default reply byte for byte -- status line plus
  // Connection: close and nothing else -- so the wire form is preserved exactly.
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`);
});

// Bind failures previously surfaced as an unhandled 'error' event: a raw
// node:events stack trace and exit 1 with no readiness line and no diagnosis.
server.on('error', (err) => {
  const code = safeRead(err, 'code');
  if (code === 'EADDRINUSE') {
    console.error(`Cannot start: ${hostname}:${port} is already in use. Stop the process holding it or choose another port.`);
  } else if (code === 'EACCES') {
    console.error(`Cannot start: permission denied binding ${hostname}:${port}.`);
  } else {
    console.error(`Server error: ${safeDetail(err)}`);
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
    if (err && safeRead(err, 'code') !== 'ERR_SERVER_NOT_RUNNING') {
      console.error(`Error during shutdown: ${safeLabel(err)}`);
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

// The single owner of the process-fatal path. The process state is undefined by
// the time this runs, so it does the least it can while still guaranteeing three
// things: exactly one fatal record, that record actually reaching stderr, and an
// exit that cannot hang.
function fatal(record) {
  if (fatalHandled) return;
  fatalHandled = true;
  // Set before anything that could be interrupted, so the status is 1 even if the
  // process leaves by some route other than the exit() below.
  process.exitCode = 1;
  // Stop serving. Nothing should receive a success answer out of an undefined
  // state during the short window before the exit. This assignment cannot fail,
  // so it is safe to make before the record is on its way.
  shuttingDown = true;

  let exited = false;
  const leave = () => {
    if (exited) return;
    exited = true;
    process.exit(1);
  };
  // The bound on the wait below. Deliberately not unref'd: it is what keeps the
  // loop alive long enough to reach the exit, and it is what stops a stderr that
  // never drains from turning this handler into a hang.
  const failsafe = setTimeout(leave, FATAL_FLUSH_MS);

  let recordQueued = false;
  try {
    // process.exit() terminates synchronously and abandons whatever a stream still
    // has queued, and stderr is asynchronous whenever it is a pipe -- which is how
    // a supervised process is normally run. Exiting straight after the write would
    // therefore discard the only record of the failure, so the exit waits for this
    // callback instead. Measured: with stderr a saturated pipe, writing and exiting
    // immediately delivered the record 0 times out of 1.
    process.stderr.write(`${record}\n`, () => {
      clearTimeout(failsafe);
      leave();
    });
    recordQueued = true;
    // Stop accepting, now that the record cannot be lost by a later failure.
    if (server.listening) {
      server.close();
    }
    // Then stop serving. close() deliberately keeps established connections, so on
    // its own it leaves a request dispatched before the fatal event free to reach
    // its deferred completion and commit a 200 inside the flush window -- measured
    // on this file before this call existed. Terminating the connections is what
    // actually ends work already in progress, and it has to run whether or not the
    // listener was still open, because a fatal raised during a drain finds it
    // closed already. Ordered after close(), which is the order the runtime
    // documents for these two calls. This is not a graceful stop: no drain is
    // announced and no lifecycle line is written, because the process is leaving.
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    } else {
      for (const socket of sockets) socket.destroy();
    }
  } catch (fatalPathError) {
    // An exception escaping a fatal handler is not caught again and would replace
    // exit 1 with the runtime's own internal-error status. If the record never
    // reached the stream there is nothing left to wait for, so leave now;
    // otherwise the pending write still owns the exit.
    if (!recordQueued) {
      clearTimeout(failsafe);
      leave();
    }
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Last resort only: the process is in an undefined state, so log and exit. The
// record is built here and delivered by fatal(); the build is guarded because a
// thrown value is arbitrary and this handler's own exceptions are not caught.
process.on('uncaughtException', (err, origin) => {
  let record;
  try {
    record = `Fatal: uncaught exception (origin=${safeValue(origin)}): ${safeDetail(err)}`;
  } catch (formatError) {
    record = `Fatal: uncaught exception: ${UNPRINTABLE_DETAIL}`;
  }
  fatal(record);
});
process.on('unhandledRejection', (reason) => {
  let record;
  try {
    // safeDetail() prefers a string `stack`, so a rejected Error still reports its
    // stack and any other rejection reason -- Node permits any value -- reports
    // itself on one line rather than throwing on the way to the log.
    record = `Fatal: unhandled promise rejection: ${safeDetail(reason)}`;
  } catch (formatError) {
    record = `Fatal: unhandled promise rejection: ${UNPRINTABLE_DETAIL}`;
  }
  fatal(record);
});

server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});
