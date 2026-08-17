// src/ai/gemini.provider.ts — Adaptador para Google Gemini

import { GoogleGenAI } from '@google/genai';
import { Injectable, Logger } from '@nestjs/common';

import { PedidoIA, ProveedorIA, RespuestaIA } from './ai-provider.interface';
import { conReintentos } from './retry.util';

@Injectable()
export class GeminiProvider implements ProveedorIA {
  readonly nombre = 'Gemini';
  readonly modelo = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

  private readonly logger = new Logger(GeminiProvider.name);
  private readonly client = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY ?? '',
  });

  /** Intentos totales por request, incluido el primero. 1 = sin reintentos. */
  private readonly intentos = Number(process.env.AI_INTENTOS ?? 3);

  async generar(pedido: PedidoIA): Promise<RespuestaIA> {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY no configurada');
    }

    const parametros = {
      model: this.modelo,
      // Gemini usa 'model' donde Claude usa 'assistant'.
      contents: [
        ...pedido.historial.map((turno) => ({
          role: turno.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: turno.content }],
        })),
        { role: 'user', parts: [{ text: pedido.mensaje }] },
      ],
      config: {
        systemInstruction: pedido.systemPrompt,
        maxOutputTokens: pedido.maxTokens,
        ...this.configRazonamiento(),
      },
    };

    // El SDK de Google no reintenta solo. Los modelos flash devuelven 503
    // ("high demand") en los picos, y sin reintentos el cliente recibe el
    // mensaje de error en vez de una respuesta.
    const respuesta = await conReintentos(
      () => this.client.models.generateContent(parametros),
      {
        intentos: this.intentos,
        alReintentar: (intento, total, esperaMs, error) => {
          const status = (error as { status?: number }).status ?? 'sin status';
          this.logger.warn(
            `Gemini falló (${status}), reintento ${intento}/${total - 1} en ${esperaMs}ms`,
          );
        },
      },
    );

    // Gemini no devuelve un error cuando bloquea: deja promptFeedback con
    // blockReason y candidates vacío. Hay que chequearlo antes de leer el texto.
    const bloqueo = respuesta.promptFeedback?.blockReason;
    if (bloqueo) {
      return { texto: '', rechazado: true, motivoRechazo: String(bloqueo) };
    }

    const finish = respuesta.candidates?.[0]?.finishReason;

    // finishReason distinto de STOP/MAX_TOKENS significa que se cortó por
    // filtros de seguridad o recitación, y el texto puede venir vacío.
    if (finish && finish !== 'STOP' && finish !== 'MAX_TOKENS') {
      this.logger.warn(`Generación interrumpida por Gemini: ${finish}`);
      return { texto: '', rechazado: true, motivoRechazo: String(finish) };
    }

    // MAX_TOKENS es más peligroso de lo que parece en los modelos que razonan:
    // maxOutputTokens es un techo sobre thinking + respuesta, así que si el
    // razonamiento se come el presupuesto, lo que sale es la cola del
    // razonamiento en crudo — texto interno, a veces en inglés, cortado a mitad
    // de frase. Enviárselo a un cliente es peor que no responder, así que lo
    // tratamos como fallo y BrainService usa el mensaje de error.
    if (finish === 'MAX_TOKENS') {
      this.logger.error(
        `Respuesta truncada por maxOutputTokens (${pedido.maxTokens}). En los modelos que ` +
          'razonan el presupuesto cubre thinking + respuesta: subí AI_MAX_TOKENS o ' +
          'bajá el razonamiento con GEMINI_THINKING_LEVEL=low.',
      );
      return { texto: '', rechazado: true, motivoRechazo: 'MAX_TOKENS' };
    }

    const uso = respuesta.usageMetadata;

    return {
      texto: (respuesta.text ?? '').trim(),
      rechazado: false,
      uso: uso
        ? {
            entrada: uso.promptTokenCount ?? 0,
            salida: uso.candidatesTokenCount ?? 0,
          }
        : undefined,
    };
  }

  /**
   * Control de razonamiento. Es el equivalente del `effort` de Claude, pero la
   * API cambió entre generaciones y los valores válidos dependen del modelo:
   *
   *   - GEMINI_THINKING_LEVEL (low | medium | high) → forma nueva, la de los 3.x
   *   - GEMINI_THINKING_BUDGET (tokens, o -1 dinámico) → forma vieja
   *
   * Si no se define ninguna, no mandamos `thinkingConfig` y el modelo decide.
   *
   * Ojo con el 0: en los Gemini 2.5 desactivaba el razonamiento, pero los 3.x
   * razonan siempre y devuelven 400 INVALID_ARGUMENT. Lo ignoramos en vez de
   * dejar que rompa cada request.
   */
  private configRazonamiento(): { thinkingConfig?: Record<string, unknown> } {
    const nivel = process.env.GEMINI_THINKING_LEVEL?.trim().toLowerCase();
    if (nivel) {
      return { thinkingConfig: { thinkingLevel: nivel } };
    }

    const bruto = process.env.GEMINI_THINKING_BUDGET?.trim();
    if (!bruto) return {};

    const presupuesto = Number(bruto);
    if (!Number.isFinite(presupuesto)) {
      this.logger.warn(`GEMINI_THINKING_BUDGET="${bruto}" no es un número, se ignora`);
      return {};
    }
    if (presupuesto === 0) {
      this.logger.warn(
        'GEMINI_THINKING_BUDGET=0 no es válido en los modelos Gemini 3.x (razonan siempre). ' +
          'Se ignora — usá GEMINI_THINKING_LEVEL=low para bajar la latencia.',
      );
      return {};
    }

    return { thinkingConfig: { thinkingBudget: presupuesto } };
  }
}
