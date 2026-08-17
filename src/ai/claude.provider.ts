// src/ai/claude.provider.ts — Adaptador para Anthropic Claude

import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';

import { PedidoIA, ProveedorIA, RespuestaIA } from './ai-provider.interface';

/** Nivel de esfuerzo del modelo. `low` es lo adecuado para chat de WhatsApp. */
type NivelEsfuerzo = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

@Injectable()
export class ClaudeProvider implements ProveedorIA {
  readonly nombre = 'Claude';
  readonly modelo = process.env.ANTHROPIC_MODEL ?? 'claude-opus-5';

  private readonly logger = new Logger(ClaudeProvider.name);
  private readonly esfuerzo = (process.env.ANTHROPIC_EFFORT ?? 'low') as NivelEsfuerzo;

  /**
   * Toma ANTHROPIC_API_KEY del entorno.
   *
   * A diferencia del SDK de Google, este reintenta solo los 408/409/429/5xx
   * con backoff — por eso acá no hace falta conReintentos(). `maxRetries` son
   * reintentos ADEMÁS del primer intento, así que restamos uno para que
   * AI_INTENTOS signifique lo mismo en los dos proveedores.
   */
  private readonly client = new Anthropic({
    maxRetries: Math.max(0, Number(process.env.AI_INTENTOS ?? 3) - 1),
  });

  async generar(pedido: PedidoIA): Promise<RespuestaIA> {
    const respuesta = await this.client.messages.create({
      model: this.modelo,
      max_tokens: pedido.maxTokens,
      system: pedido.systemPrompt,
      output_config: { effort: this.esfuerzo },
      messages: [
        ...pedido.historial.map((turno) => ({
          role: turno.role,
          content: turno.content,
        })),
        { role: 'user' as const, content: pedido.mensaje },
      ],
    });

    // Claude puede rechazar un pedido por políticas: llega un 200 con
    // stop_reason "refusal" y content vacío o parcial. Hay que chequearlo
    // ANTES de leer content, o el índice explota.
    if (respuesta.stop_reason === 'refusal') {
      return {
        texto: '',
        rechazado: true,
        motivoRechazo: respuesta.stop_details?.category ?? 'sin categoría',
      };
    }

    // content es una unión discriminada: hay que filtrar por type.
    const texto = respuesta.content
      .filter((bloque): bloque is Anthropic.TextBlock => bloque.type === 'text')
      .map((bloque) => bloque.text)
      .join('\n')
      .trim();

    return {
      texto,
      rechazado: false,
      uso: {
        entrada: respuesta.usage.input_tokens,
        salida: respuesta.usage.output_tokens,
      },
    };
  }
}
