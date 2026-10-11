import type { FastifyReply } from 'fastify';

/** An error the API answers as `{ error: code }` with its own status; the subclasses name each domain. */
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** Answers an ApiError with its status and code; the caller keeps its own `instanceof` check. */
export function sendApiError(reply: FastifyReply, err: ApiError): FastifyReply {
  return reply.code(err.status).send({ error: err.code });
}
