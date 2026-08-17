// src/providers/whatsapp-provider.interface.ts — Contrato común de proveedores

import { Request } from 'express';

/** Mensaje normalizado — mismo formato sin importar el proveedor. */
export interface MensajeEntrante {
  /** Número del cliente (siempre la contraparte, nunca el del negocio). */
  telefono: string;
  texto: string;
  mensajeId: string;
  /** True si viene de un anuncio (Click-to-WhatsApp). */
  desdePublicidad: boolean;
  /** ID del anuncio de origen, si aplica. */
  referralSource: string;
  /**
   * True si lo escribió una persona desde la app WhatsApp Business
   * (coexistencia). No se ignora: deriva la conversación para que el
   * agente se calle.
   */
  esEchoHumano: boolean;
  /**
   * Nombre del perfil de WhatsApp del cliente, si Meta lo manda. Se usa para
   * personalizar las plantillas (el {{1}} del recontacto) y el trato en la
   * conversación. Vacío si no vino.
   */
  nombrePerfil: string;
}

/** Valores de los parámetros de una plantilla: nombrados o posicionales. */
export type ParametrosPlantilla = Record<string, string> | string[];

export interface OpcionesPlantilla {
  /** Variables del BODY. */
  parametros?: ParametrosPlantilla;
  /** Variables del HEADER. Cada componente cuenta sus variables aparte. */
  parametrosHeader?: ParametrosPlantilla;
  /** Código de idioma exacto de la plantilla (es, es_MX, en_US...). */
  idioma?: string;
}

export interface ProveedorWhatsApp {
  /** Verificación GET del webhook. Devuelve el challenge, o null si no aplica. */
  validarWebhook(req: Request): string | null;

  /** Extrae y normaliza los mensajes del payload del webhook. */
  parsearWebhook(body: unknown): MensajeEntrante[];

  /** Envía un mensaje de texto libre (solo dentro de la ventana de 24 h). */
  enviarMensaje(telefono: string, mensaje: string): Promise<boolean>;

  /** Envía una plantilla aprobada. Única vía fuera de la ventana de 24 h. */
  enviarPlantilla(telefono: string, plantilla: string, opciones?: OpcionesPlantilla): Promise<boolean>;
}

export const PROVEEDOR_WHATSAPP = Symbol('PROVEEDOR_WHATSAPP');
