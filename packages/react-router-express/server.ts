import type * as express from "express";
import type {
  AppLoadContext,
  ServerBuild,
  UNSAFE_ServerMode,
} from "react-router";
import { createRequestHandler as createRequestHandler_ } from "react-router";

export interface RequestHandlerOptions {
  build: ServerBuild | (() => Promise<ServerBuild>);
  getLoadContext?: (
    req: express.Request,
    res: express.Response
  ) => Promise<AppLoadContext> | AppLoadContext;
  mode?: UNSAFE_ServerMode;
}

/**
 * Returns a request handler for Express that serves the response using React Router.
 */
export function createRequestHandler(
  options: RequestHandlerOptions
): express.RequestHandler {
  let handleRequest = createRequestHandler_(
    options.build,
    options.mode ?? process.env.NODE_ENV
  );

  return async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    try {
      let request = createRequest(req, res);
      let loadContext = await options.getLoadContext?.(req, res);

      let response = await handleRequest(request, loadContext);

      await sendResponse(res, response);
    } catch (error: unknown) {
      // Express doesn't support async functions, so we have to pass along the
      // error manually using next().
      next(error);
    }
  };
}

export function createRequest(
  req: express.Request,
  res: express.Response
): Request {
  // req.hostname doesn't include port information so grab that from
  // `X-Forwarded-Host` or `Host`
  let [, hostnamePort] = req.get("X-Forwarded-Host")?.split(":") ?? [];
  let [, hostPort] = req.get("host")?.split(":") ?? [];
  let port = hostnamePort || hostPort;
  // Use req.hostname here as it respects the "trust proxy" setting
  let resolvedHost = `${req.hostname}${port ? `:${port}` : ""}`;
  // Use `req.originalUrl` so Remix is aware of the full path
  let url = new URL(`${req.protocol}://${resolvedHost}${req.originalUrl}`);

  // Abort action/loaders once we can no longer write a response
  let controller: AbortController | null = new AbortController();
  let init: RequestInit = {
    method: req.method,
    headers: createHeaders(req.headers),
    signal: controller.signal,
  };

  // Abort action/loaders once we can no longer write a response iff we have
  // not yet sent a response (i.e., `close` without `finish`)
  // `finish` -> done rendering the response
  // `close` -> response can no longer be written to
  res.on("finish", () => (controller = null));
  res.on("close", () => controller?.abort());

  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = new ReadableStream({
      start(controller) {
        req.on("data", (chunk) => {
          controller.enqueue(
            new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          );
        });
        req.on("end", () => {
          controller.close();
        });
      },
    });

    // init.duplex = 'half' must be set when body is a ReadableStream, and Node follows the spec.
    // However, this property is not defined in the TypeScript types for RequestInit, so we have
    // to cast it here in order to set it without a type error.
    // See https://fetch.spec.whatwg.org/#dom-requestinit-duplex
    (init as { duplex: "half" }).duplex = "half";
  }

  return new Request(url.href, init);
}

export function createHeaders(
  requestHeaders: express.Request["headers"]
): Headers {
  let headers = new Headers();

  for (let [key, values] of Object.entries(requestHeaders)) {
    if (values) {
      if (Array.isArray(values)) {
        for (let value of values) {
          headers.append(key, value);
        }
      } else {
        headers.set(key, values);
      }
    }
  }

  return headers;
}

export async function sendResponse(
  res: express.Response,
  response: Response
): Promise<void> {
  res.statusMessage = response.statusText;
  res.status(response.status);

  for (let [key, value] of response.headers.entries()) {
    res.append(key, value);
  }

  if (response.headers.get("Content-Type")?.match(/text\/event-stream/i)) {
    res.flushHeaders();
  }

  if (response.body) {
    for await (let chunk of response.body) {
      res.write(chunk);
    }
  }

  res.end();
}
