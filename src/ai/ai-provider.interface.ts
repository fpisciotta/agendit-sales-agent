// src/ai/ai-provider.interface.ts — Contrato común de proveedores de IA
//
// Misma idea que providers/whatsapp-provider.interface.ts: el resto del código
// no sabe con qué modelo habla. Para agregar un proveedor, implementá
// ProveedorIA y registralo en ai.module.ts.

import { TurnoConversacion } from '../memory/memory.service';

export interface PedidoIA {
  /** Instrucciones del sistema (el prompt del negocio). */
  systemPrompt: string;
  /** Turnos anteriores en orden cronológico, SIN el mensaje nuevo. */
  historial: TurnoConversacion[];
  /** Mensaje nuevo del cliente. */
  mensaje: string;
  maxTokens: number;
}

export interface RespuestaIA {
  /** Texto de la respuesta. Vacío si el modelo no produjo nada. */
  texto: string;
  /**
   * True si el proveedor rechazó el pedido por sus políticas de seguridad.
   * No es un error de red: la llamada fue exitosa y no hay texto que enviar.
   */
  rechazado: boolean;
  /** Motivo del rechazo, cuando el proveedor lo informa. */
  motivoRechazo?: string;
  /** Tokens consumidos, si el proveedor los reporta. */
  uso?: { entrada: number; salida: number };
}

export interface ProveedorIA {
  /** Nombre legible, para los logs. */
  readonly nombre: string;
  /** Modelo en uso, para los logs. */
  readonly modelo: string;
  /**
   * Genera una respuesta. Debe lanzar en caso de error de red o de API —
   * BrainService se encarga de traducirlo a un mensaje para el cliente.
   */
  generar(pedido: PedidoIA): Promise<RespuestaIA>;
}

export const PROVEEDOR_IA = Symbol('PROVEEDOR_IA');
