// src/brain/brain.service.ts — Cerebro del agente
//
// No habla con ningún SDK: orquesta el proveedor de IA inyectado y traduce
// los fallos a mensajes que el cliente puede leer. Para cambiar de modelo,
// se toca AI_PROVIDER, no este archivo.

import Anthropic from '@anthropic-ai/sdk';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { PROVEEDOR_IA, ProveedorIA } from '../ai/ai-provider.interface';
import { PromptsConfigService } from '../config/prompts-config.service';
import { TurnoConversacion } from '../memory/memory.service';

@Injectable()
export class BrainService {
  private readonly logger = new Logger(BrainService.name);
  /**
   * Techo de tokens de salida. En los modelos que razonan cubre thinking +
   * respuesta, así que un valor bajo hace que el razonamiento se coma el
   * presupuesto y la respuesta salga truncada.
   */
  private readonly maxTokens = Number(process.env.AI_MAX_TOKENS ?? 3000);

  constructor(
    @Inject(PROVEEDOR_IA) private readonly ia: ProveedorIA,
    private readonly config: PromptsConfigService,
  ) {}

  /**
   * Genera la respuesta del agente.
   *
   * @param mensaje   Mensaje nuevo del cliente
   * @param historial Turnos anteriores, en orden cronológico y SIN el mensaje nuevo
   */
  async generarRespuesta(mensaje: string, historial: TurnoConversacion[]): Promise<string> {
    if (mensaje.trim().length < 2) {
      return this.config.mensajeFallback;
    }

    try {
      const respuesta = await this.ia.generar({
        systemPrompt: this.config.systemPrompt,
        historial,
        mensaje,
        maxTokens: this.maxTokens,
      });

      if (respuesta.rechazado) {
        this.logger.warn(
          `${this.ia.nombre} rechazó el pedido (${respuesta.motivoRechazo ?? 'sin motivo'})`,
        );
        return this.config.mensajeError;
      }

      if (respuesta.uso) {
        this.logger.log(
          `Respuesta de ${this.ia.nombre} (${respuesta.uso.entrada} in / ${respuesta.uso.salida} out)`,
        );
      }

      return respuesta.texto.length > 0 ? respuesta.texto : this.config.mensajeFallback;
    } catch (error) {
      this.registrarError(error);
      return this.config.mensajeError;
    }
  }

  /**
   * Distingue los fallos que valen un log específico. Los de Claude usan las
   * clases tipadas del SDK; Gemini no expone equivalentes, así que cae en el
   * caso genérico.
   */
  private registrarError(error: unknown): void {
    if (error instanceof Anthropic.RateLimitError) {
      this.logger.error(`${this.ia.nombre}: rate limit alcanzado`);
      return;
    }
    if (error instanceof Anthropic.AuthenticationError) {
      this.logger.error(`${this.ia.nombre}: API key inválida o ausente`);
      return;
    }
    if (error instanceof Anthropic.APIError) {
      this.logger.error(`${this.ia.nombre} API error ${error.status}: ${error.message}`);
      return;
    }
    this.logger.error(
      `Error inesperado al llamar a ${this.ia.nombre}: ${(error as Error).message}`,
    );
  }
}
