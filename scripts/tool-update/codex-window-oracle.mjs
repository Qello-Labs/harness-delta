import {
	WindowConformanceError,
	windowRequire,
} from "./codex-window-conformance.mjs";
import { createServer } from "node:net";
import { EventEmitter } from "node:events";

function usageVector(value) {
	windowRequire(
		value &&
			Object.keys(value).sort().join(",") ===
				"cached,input,output,reasoning" &&
			Object.values(value).every((number) =>
				Number.isSafeInteger(number) && number >= 0
			) &&
			value.cached <= value.input && value.reasoning <= value.output &&
			value.input + value.output <= 4000,
		"usage_invalid",
	);
	return Object.freeze({ ...value });
}

function parseHeaders(bytes) {
	const lines = bytes.toString("latin1").split("\r\n");
	windowRequire(
		lines.shift() === "POST /v1/responses HTTP/1.1",
		"protocol_refused",
	);
	const headers = new Map();
	for (const line of lines.filter(Boolean)) {
		const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([ -~]*)$/.exec(
			line,
		);
		windowRequire(match, "framing_refused");
		const name = match[1].toLowerCase();
		windowRequire(!headers.has(name), "framing_refused");
		headers.set(name, match[2].trim());
	}
	windowRequire(
		!headers.has("upgrade") &&
			!/\bupgrade\b/i.test(headers.get("connection") ?? ""),
		"protocol_refused",
	);
	windowRequire(
		!headers.has("content-encoding") ||
			headers.get("content-encoding").toLowerCase() === "identity",
		"compression_refused",
	);
	windowRequire(
		!headers.has("transfer-encoding") &&
			/^[0-9]+$/.test(headers.get("content-length") ?? ""),
		"framing_refused",
	);
	windowRequire(
		/^127\.0\.0\.1(?::[0-9]{1,5})?$/.test(headers.get("host") ?? "") &&
			!headers.has("authorization"),
		"request_refused",
	);
	const length = Number(headers.get("content-length"));
	windowRequire(
		Number.isSafeInteger(length) && length <= 65536,
		"body_limit",
	);
	return length;
}

function parseRequest(bytes) {
	let request;
	try {
		request = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new WindowConformanceError("request_refused");
	}
	windowRequire(
		request &&
			Object.keys(request).sort().join(",") ===
				"input,model,reasoning,stream" &&
			request.model === "gpt-6.1-sol" && request.stream === true &&
			request.reasoning &&
			Object.keys(request.reasoning).join(",") === "effort" &&
			request.reasoning.effort === "high" &&
			(typeof request.input === "string" || Array.isArray(request.input)),
		"request_refused",
	);
}

function responseParts(index, vector) {
	const id = `resp_synthetic_${index}`;
	const event = (type, response) =>
		Buffer.from(
			`event: ${type}\ndata: ${JSON.stringify({ type, response })}\n\n`,
		);
	const first = Buffer.concat([
		Buffer.from(
			"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Encoding: identity\r\nConnection: close\r\n\r\n",
		),
		event("response.created", {
			id,
			object: "response",
			status: "in_progress",
		}),
	]);
	const final = event("response.completed", {
		id,
		object: "response",
		status: "completed",
		output: [],
		usage: {
			input_tokens: vector.input,
			output_tokens: vector.output,
			total_tokens: vector.input + vector.output,
			input_tokens_details: { cached_tokens: vector.cached },
			output_tokens_details: { reasoning_tokens: vector.reasoning },
		},
	});
	windowRequire(first.length + final.length <= 262144, "response_limit");
	return { first, final };
}

function connectionFor(oracle) {
	const header = Buffer.alloc(16384);
	let headerSize = 0;
	let body;
	let bodySize = 0;
	let wireSize = 0;
	let state = "headers";
	let response;
	const fail = (code) => {
		body = undefined;
		oracle.buffered(0);
		oracle.stop(code);
		throw new WindowConformanceError(code);
	};
	return Object.freeze({
		receive(chunk) {
			try {
				oracle.live();
				windowRequire(
					Buffer.isBuffer(chunk) && state !== "closed" &&
						state !== "started" && state !== "completed",
					"response_state",
				);
				wireSize += chunk.length;
				oracle.charge("request", chunk.length);
				windowRequire(wireSize <= 81920, "wire_limit");
				for (const byte of chunk) {
					if (state === "headers") {
						windowRequire(headerSize < header.length, "wire_limit");
						header[headerSize++] = byte;
						if (
							headerSize >= 4 &&
							header.subarray(headerSize - 4, headerSize).equals(
								Buffer.from("\r\n\r\n"),
							)
						) {
							const length = parseHeaders(
								header.subarray(0, headerSize),
							);
							oracle.requestAttempt();
							body = Buffer.alloc(length);
							oracle.buffered(length);
							state = "body";
						}
					} else {
						windowRequire(
							state === "body" && bodySize < body.length,
							"framing_refused",
						);
						body[bodySize++] = byte;
					}
				}
				if (state === "body" && bodySize === body.length) {
					parseRequest(body);
					response = oracle.accept();
					body = undefined;
					oracle.buffered(0);
					state = "ready";
				}
				return state === "ready";
			} catch (error) {
				fail(
					error instanceof WindowConformanceError
						? error.code
						: "request_refused",
				);
			}
		},
		start() {
			oracle.live();
			windowRequire(state === "ready", "response_state");
			oracle.charge("response", response.first.length);
			state = "started";
			return response.first;
		},
		complete() {
			oracle.live();
			windowRequire(state === "started", "response_state");
			oracle.charge("response", response.final.length);
			state = "completed";
			oracle.complete();
			return response.final;
		},
		close() {
			windowRequire(state !== "closed", "connection_closed");
			body = undefined;
			oracle.buffered(0);
			state = "closed";
			oracle.close();
		},
	});
}

function createOracle(vectors, batch) {
	windowRequire(!batch.stopped, "oracle_stopped");
	windowRequire(
		Array.isArray(vectors) && vectors.length >= 1 && vectors.length <= 2,
		"usage_invalid",
	);
	const selected = vectors.map(usageVector);
	let connections = 0, requests = 0, completed = 0, httpRequests = 0;
	let requestWire = 0, responseWire = 0, bufferedBody = 0;
	let connected = false, stopped = false;
	const totals = { input: 0, output: 0, cached: 0, reasoning: 0 };
	const stop = (code) => {
		stopped = true;
		batch.stop(code);
	};
	const check = (condition, code) => {
		if (!condition) {
			stop(code);
			throw new WindowConformanceError(code);
		}
	};
	const live = () =>
		windowRequire(!stopped && !batch.stopped, "oracle_stopped");
	return Object.freeze({
		connect() {
			live();
			connections++;
			batch.connections++;
			check(
				!connected && !batch.connected && connections <= 16 &&
					batch.connections <= 112,
				"connection_limit",
			);
			connected = true;
			batch.connected = true;
			return connectionFor({
				stop,
				live,
				buffered(bytes) {
					bufferedBody = bytes;
				},
				charge(direction, bytes) {
					if (direction === "request") {
						requestWire += bytes;
						batch.requestWire += bytes;
						check(
							requestWire <= 1310720 &&
								batch.requestWire <= 9175040,
							"wire_limit",
						);
					} else {
						responseWire += bytes;
						batch.responseWire += bytes;
						check(
							responseWire <= 4194304 &&
								batch.responseWire <= 29360128,
							"response_limit",
						);
					}
				},
				requestAttempt() {
					httpRequests++;
					batch.requests++;
					check(
						httpRequests <= 16 && batch.requests <= 112,
						"request_limit",
					);
				},
				accept() {
					check(
						requests < selected.length && batch.responses < 8,
						"response_limit",
					);
					const vector = selected[requests++];
					batch.responses++;
					batch.usage += vector.input + vector.output;
					check(batch.usage <= 32000, "usage_invalid");
					return responseParts(requests, vector);
				},
				complete() {
					const vector = selected[requests - 1];
					completed++;
					for (const key of Object.keys(totals)) {
						totals[key] += vector[key];
					}
				},
				close() {
					connected = false;
					batch.connected = false;
				},
			});
		},
		summary() {
			const complete = completed === requests && requests > 0;
			return {
				origin: "synthetic",
				actual_qualification: false,
				connections,
				http_requests: httpRequests,
				requests,
				completed,
				request_wire_bytes: requestWire,
				response_wire_bytes: responseWire,
				buffered_body_bytes: bufferedBody,
				terminal_usage: complete ? "observed" : "missing",
				input_tokens: complete ? totals.input : null,
				output_tokens: complete ? totals.output : null,
				cached_input_tokens: complete ? totals.cached : null,
				reasoning_tokens: complete ? totals.reasoning : null,
				stopped: stopped || batch.stopped,
			};
		},
	});
}

export function createWindowOracleBatch() {
	const batch = {
		connections: 0,
		requests: 0,
		responses: 0,
		usage: 0,
		requestWire: 0,
		responseWire: 0,
		stopped: false,
		connected: false,
		stopHandlers: new Set(),
		stop(code) {
			if (batch.stopped) return;
			batch.stopped = true;
			for (const handler of [...batch.stopHandlers]) handler(code);
		},
	};
	const createCase = (vectors) => {
		windowRequire(!batch.stopped, "oracle_stopped");
		try {
			return createOracle(vectors, batch);
		} catch (error) {
			batch.stop(
				error instanceof WindowConformanceError
					? error.code
					: "transport_failed",
			);
			throw error;
		}
	};
	return Object.freeze({
		createCase,
		createServer: (vectors, options) => {
			windowRequire(!batch.stopped, "oracle_stopped");
			try {
				return serveWindowOracle(
					createCase(vectors),
					options,
					batch,
				);
			} catch (error) {
				batch.stop(
					error instanceof WindowConformanceError
						? error.code
						: "transport_failed",
				);
				throw error;
			}
		},
	});
}

export function createWindowOracle(vectors) {
	return createWindowOracleBatch().createCase(vectors);
}

function acceptWindowSocket(socket, oracle, state, events, refuse) {
	if (state.stopping) {
		socket.destroy();
		return;
	}
	state.sockets.add(socket);
	socket.on("error", () => refuse("transport_failed"));
	let connection;
	try {
		connection = oracle.connect();
	} catch (error) {
		socket.destroy();
		refuse(
			error instanceof WindowConformanceError
				? error.code
				: "transport_failed",
		);
		return;
	}
	const entry = { socket, connection, reported: false };
	state.active = entry;
	socket.once("close", () => {
		connection.close();
		state.sockets.delete(socket);
		if (state.active === entry) state.active = undefined;
	});
	socket.on("data", (bytes) => {
		try {
			if (connection.receive(bytes) && !entry.reported) {
				entry.reported = true;
				events.emit("request");
			}
		} catch (error) {
			refuse(
				error instanceof WindowConformanceError
					? error.code
					: "transport_failed",
			);
		}
	});
}

function sendWindowWire(socket, bytes, end) {
	return new Promise((resolveSent, reject) => {
		const done = (error) =>
			error
				? reject(new WindowConformanceError("transport_failed"))
				: resolveSent();
		if (end) socket.end(bytes, done);
		else socket.write(bytes, done);
	});
}

function serveWindowOracle(oracle, options, batch) {
	windowRequire(
		options && Number.isInteger(options.port) && options.port >= 0 &&
			options.port <= 65535 &&
			Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 &&
			options.timeoutMs <= 1200000,
		"oracle_options_invalid",
	);
	const events = new EventEmitter();
	const state = {
		sockets: new Set(),
		active: undefined,
		closed: false,
		stopping: false,
		refusal: undefined,
	};
	let timer, listening = false, closing, resolveClosed;
	const closed = new Promise((resolveClosedPromise) => {
		resolveClosed = resolveClosedPromise;
	});
	const binding = Promise.withResolvers();
	const server = createServer(
		{ highWaterMark: 16384 },
		(socket) => acceptWindowSocket(socket, oracle, state, events, refuse),
	);
	const close = () => {
		closing ??= (async () => {
			state.stopping = true;
			batch.stopHandlers.delete(batchStopped);
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			for (const socket of state.sockets) socket.destroy();
			if (listening) await binding.promise;
			if (server.listening) {
				server.close(() => {
					state.closed = true;
					resolveClosed();
				});
			} else {
				state.closed = true;
				resolveClosed();
			}
			await closed;
		})();
		return closing;
	};
	const batchStopped = (code) => {
		if (state.refusal) return;
		state.refusal = code;
		void close();
		events.emit("refused", code);
	};
	const refuse = (code) => {
		if (!state.stopping) batch.stop(code);
	};
	const abort = () => refuse("deadline_exceeded");
	batch.stopHandlers.add(batchStopped);
	options.signal?.addEventListener("abort", abort, { once: true });
	return Object.freeze({
		events,
		async listen() {
			if (options.signal?.aborted) abort();
			windowRequire(
				!listening && !state.closed && !state.stopping &&
					!batch.stopped,
				"oracle_stopped",
			);
			listening = true;
			await new Promise((resolveListening, reject) => {
				const failed = () => {
					server.removeListener("listening", ready);
					binding.resolve();
					refuse("oracle_bind_failed");
					reject(new WindowConformanceError("oracle_bind_failed"));
				};
				const ready = () => {
					server.removeListener("error", failed);
					server.on("error", () => refuse("transport_failed"));
					binding.resolve();
					resolveListening();
				};
				server.once("error", failed);
				server.once("listening", ready);
				server.listen({
					host: "127.0.0.1",
					port: options.port,
					exclusive: true,
				});
			});
			windowRequire(!state.stopping && !batch.stopped, "oracle_stopped");
			timer = setTimeout(abort, options.timeoutMs);
			if (options.signal?.aborted) abort();
			const address = server.address();
			windowRequire(
				address && typeof address !== "string" &&
					address.address === "127.0.0.1",
				"oracle_bind_failed",
			);
			return address.port;
		},
		async start() {
			try {
				windowRequire(
					state.active && !state.stopping && !batch.stopped,
					"response_state",
				);
				const { socket, connection } = state.active;
				await sendWindowWire(socket, connection.start(), false);
			} catch (error) {
				refuse("transport_failed");
				throw error;
			}
		},
		async complete() {
			try {
				windowRequire(
					state.active && !state.stopping && !batch.stopped,
					"response_state",
				);
				const { socket, connection } = state.active;
				await sendWindowWire(socket, connection.complete(), true);
			} catch (error) {
				refuse("transport_failed");
				throw error;
			}
		},
		close,
		summary() {
			return {
				...oracle.summary(),
				stopped: Boolean(state.refusal) || oracle.summary().stopped,
				listener_closed: state.closed,
			};
		},
	});
}

export function createWindowOracleServer(vectors, options) {
	return createWindowOracleBatch().createServer(vectors, options);
}
