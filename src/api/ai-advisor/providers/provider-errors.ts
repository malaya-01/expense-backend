import { HttpException, HttpStatus } from '@nestjs/common';

/** Turn raw provider HTTP failures into calm, actionable messages. */
export function providerHttpException(
  provider: string,
  status: number,
  rawMessage: string,
): HttpException {
  const raw = String(rawMessage || '').trim();
  const lower = raw.toLowerCase();
  const label =
    provider === 'openrouter'
      ? 'OpenRouter'
      : provider === 'openai'
        ? 'OpenAI'
        : provider === 'anthropic'
          ? 'Anthropic'
          : provider === 'vertex'
            ? 'Vertex AI'
            : provider === 'local'
              ? 'Local model'
              : 'AI provider';

  if (
    status === 429 ||
    /rate.?limit|too many requests|free-models-per-day|free.?tier|quota.?exceeded|tpm|rpm/i.test(
      lower,
    )
  ) {
    const message =
      provider === 'openrouter'
        ? 'OpenRouter free daily limit reached. Wait for the reset, switch to another free model (look for :free), or add credits — then retry.'
        : `${label} rate-limited this request. Wait a moment and try again.`;
    return new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
  }

  if (
    status === 402 ||
    /insufficient.?credits|payment.?required|add.?credits|billing|credit.?balance|out of credits/i.test(
      lower,
    )
  ) {
    const message =
      provider === 'openrouter'
        ? 'This OpenRouter model needs credits. Add credits at openrouter.ai/credits, or pick a free model ending in :free in Settings → AI.'
        : `${label} requires billing or credits for this model. Check your provider account, then retry.`;
    return new HttpException(message, HttpStatus.PAYMENT_REQUIRED);
  }

  if (status === 401 || status === 403 || /invalid.?api.?key|unauthorized|forbidden|authentication/i.test(lower)) {
    return new HttpException(
      `${label} rejected the API key. Re-check the key in Settings → AI, then Test connection.`,
      HttpStatus.UNAUTHORIZED,
    );
  }

  if (
    status === 404 ||
    /model.?not.?found|no such model|does not exist|unknown model/i.test(lower)
  ) {
    return new HttpException(
      `${label} could not find that model. Pick another model in Settings → AI (OpenRouter free models often end with :free).`,
      HttpStatus.NOT_FOUND,
    );
  }

  if (status === 503 || status === 502 || /overloaded|temporarily unavailable|capacity/i.test(lower)) {
    return new HttpException(
      `${label} is temporarily overloaded. Try again in a minute, or switch models.`,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  const detail = raw && raw.length < 280 ? raw : `${status} ${statusText(status)}`;
  return new HttpException(
    `${label} could not complete the request (${detail}). Try again, or switch models in Settings → AI.`,
    status >= 400 && status < 600 ? status : HttpStatus.BAD_GATEWAY,
  );
}

function statusText(status: number) {
  switch (status) {
    case 400:
      return 'bad request';
    case 408:
      return 'timeout';
    case 500:
      return 'server error';
    default:
      return 'error';
  }
}
