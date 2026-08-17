// src/ai/retry.util.ts — Reintentos con backoff exponencial y jitter

/** Códigos HTTP que vale reintentar: el problema es del servidor, no del pedido. */
const CODIGOS_REINTENTABLES = new Set([408, 429, 500, 502, 503, 504]);

export interface OpcionesReintento {
  /** Intentos totales, incluido el primero. 1 = sin reintentos. */
  intentos: number;
  /** Espera del primer reintento en ms; se duplica en cada vuelta. */
  esperaBaseMs: number;
  /** Techo de la espera, para no dejar al cliente esperando de más. */
  esperaMaximaMs: number;
  /** Se llama antes de cada reintento, para loguear. */
  alReintentar?: (intento: number, totalIntentos: number, esperaMs: number, error: unknown) => void;
}

export const OPCIONES_POR_DEFECTO: OpcionesReintento = {
  intentos: 3,
  esperaBaseMs: 600,
  esperaMaximaMs: 5000,
};

/**
 * Cuánto pide esperar el servidor, si lo informa, en ms.
 *
 * Google devuelve un RetryInfo dentro del JSON del mensaje de error. Sirve para
 * distinguir dos 429 que se parecen pero no lo son: un rate limit por minuto
 * pide un par de segundos y vale reintentarlo; una cuota diaria agotada pide
 * medio minuto o más y reintentar solo agrega latencia antes del mismo fallo.
 *
 * Devuelve null si no hay dato.
 */
export function retryDelaySugeridoMs(error: unknown): number | null {
  const mensaje = (error as { message?: unknown })?.message;
  if (typeof mensaje !== 'string') return null;

  try {
    const cuerpo = JSON.parse(mensaje) as {
      error?: { details?: Array<{ '@type'?: string; retryDelay?: string }> };
    };
    for (const detalle of cuerpo.error?.details ?? []) {
      if (!detalle['@type']?.endsWith('RetryInfo')) continue;
      const segundos = Number.parseFloat(detalle.retryDelay ?? '');
      if (Number.isFinite(segundos)) return segundos * 1000;
    }
  } catch {
    // El mensaje no era JSON: no hay RetryInfo que leer.
  }
  return null;
}

/**
 * Decide si un error merece otro intento.
 *
 * Reintentables: 429 (rate limit), 5xx (incluido el 503 "high demand" que los
 * modelos flash tiran en los picos) y los fallos de red, que llegan sin status.
 * NO reintentables: 400, 401, 403, 404 — el pedido está mal y va a fallar igual.
 *
 * @param esperaMaximaMs Si el servidor pide esperar más que esto, no
 *   reintentamos: es una cuota agotada, no un pico de tráfico.
 */
export function esErrorReintentable(error: unknown, esperaMaximaMs?: number): boolean {
  const status = (error as { status?: unknown })?.status;

  if (typeof status === 'number') {
    if (!CODIGOS_REINTENTABLES.has(status)) return false;

    if (esperaMaximaMs !== undefined) {
      const sugerido = retryDelaySugeridoMs(error);
      if (sugerido !== null && sugerido > esperaMaximaMs) return false;
    }
    return true;
  }

  // Sin status: probablemente un fallo de red (DNS, timeout, socket cerrado).
  // Un TypeError o similar no es de red, así que no lo reintentamos.
  return error instanceof Error && !(error instanceof TypeError);
}

/**
 * Ejecuta `fn` y la reintenta mientras el error sea transitorio.
 *
 * El jitter (±25 %) evita que varias conversaciones que fallaron al mismo
 * tiempo vuelvan a golpear la API todas juntas.
 */
export async function conReintentos<T>(
  fn: () => Promise<T>,
  opciones: Partial<OpcionesReintento> = {},
): Promise<T> {
  const { intentos, esperaBaseMs, esperaMaximaMs, alReintentar } = {
    ...OPCIONES_POR_DEFECTO,
    ...opciones,
  };

  let ultimoError: unknown;

  for (let intento = 1; intento <= intentos; intento++) {
    try {
      return await fn();
    } catch (error) {
      ultimoError = error;

      const esUltimo = intento === intentos;
      if (esUltimo || !esErrorReintentable(error, esperaMaximaMs)) {
        throw error;
      }

      const exponencial = esperaBaseMs * 2 ** (intento - 1);
      const conJitter = exponencial * (0.75 + Math.random() * 0.5);
      const esperaMs = Math.round(Math.min(conJitter, esperaMaximaMs));

      alReintentar?.(intento, intentos, esperaMs, error);
      await new Promise((resolver) => setTimeout(resolver, esperaMs));
    }
  }

  // Inalcanzable: el loop siempre retorna o lanza. Está por el tipo de retorno.
  throw ultimoError;
}
