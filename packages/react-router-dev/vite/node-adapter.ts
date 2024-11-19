import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import * as stream from "node:stream";

import { splitCookiesString } from "set-cookie-parser";
import type * as Vite from "vite";

import invariant from "../invariant";

export type NodeRequestHandler = (
  req: Vite.Connect.IncomingMessage,
  res: ServerResponse
) => Promise<void>;

function fromNodeHeaders(nodeHeaders: IncomingHttpHeaders): Headers {
  let headers = new Headers();

  for (let [key, values] of Object.entries(nodeHeaders)) {
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

// Based on `createRemixRequest` in packages/react-router-express/server.ts
export function fromNodeRequest(
  req: Vite.Connect.IncomingMessage,
  res: ServerResponse<Vite.Connect.IncomingMessage>
): Request {
  let origin =
    req.headers.origin && "null" !== req.headers.origin
      ? req.headers.origin
      : `http://${req.headers.host}`;
  // Use `req.originalUrl` so React Router is aware of the full path
  invariant(req.originalUrl, "Expected `nodeReq.originalUrl` to be defined");
  let url = new URL(req.originalUrl, origin);

  // Abort action/loaders once we can no longer write a response
  let controller: AbortController | null = new AbortController();
  let init: RequestInit = {
    method: req.method,
    headers: fromNodeHeaders(req.headers),
    signal: controller.signal,
  };

  // Abort action/loaders once we can no longer write a response iff we have
  // not yet sent a response (i.e., `close` without `finish`)
  // `finish` -> done rendering the response
  // `close` -> response can no longer be written to
  res.on("finish", () => (controller = null));
  res.on("close", () => controller?.abort());

  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = createReadableStreamFromReadable(req);
    (init as { duplex: "half" }).duplex = "half";
  }

  return new Request(url.href, init);
}

// Adapted from solid-start's `handleNodeResponse`:
// https://github.com/solidjs/solid-start/blob/7398163869b489cce503c167e284891cf51a6613/packages/start/node/fetch.js#L162-L185
export async function toNodeRequest(response: Response, res: ServerResponse) {
  res.statusCode = response.status;
  res.statusMessage = response.statusText;

  let cookiesStrings = [];

  for (let [name, value] of response.headers) {
    if (name === "set-cookie") {
      cookiesStrings.push(...splitCookiesString(value));
    } else res.setHeader(name, value);
  }

  if (cookiesStrings.length) {
    res.setHeader("set-cookie", cookiesStrings);
  }

  if (response.body) {
    for await (let chunk of response.body) {
      res.write(chunk);
    }
  }

  res.end();
}

function createReadableStreamFromReadable(
  readable: stream.Readable
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      readable.on("data", (chunk) => {
        controller.enqueue(
          new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        );
      });
      readable.on("end", () => {
        controller.close();
      });
    },
  });
}
