// src/providers/meta.provider.ts — Adaptador para Meta WhatsApp Cloud API

import { Injectable, Logger } from '@nestjs/common';
import { Request } from 'express';

import {
  MensajeEntrante,
  OpcionesPlantilla,
  ParametrosPlantilla,
  ProveedorWhatsApp,
} from './whatsapp-provider.interface';

/**
 * Cuántos IDs de mensajes propios recordamos para no confundirlos con
 * respuestas humanas. Ver esEchoPropio().
 */
const MAX_WAMIDS_RECORDADOS = 500;

// --- Tipos mínimos del payload de Meta (solo lo que consumimos) ---

interface BloqueTexto {
  body?: string;
}

interface MensajeMeta {
  from?: string;
  to?: string;
  id?: string;
  type?: string;
  text?: BloqueTexto;
  referral?: { source_type?: string; source_id?: string };
}

interface EstadoMeta {
  status?: string;
  recipient_id?: string;
  errors?: Array<{
    code?: number;
    title?: string;
    error_data?: { details?: string };
  }>;
}

interface ValorCambio {
  messages?: MensajeMeta[];
  message_echoes?: MensajeMeta[];
  statuses?: EstadoMeta[];
}

interface CambioMeta {
  field?: string;
  value?: ValorCambio;
}

interface PayloadMeta {
  entry?: Array<{ changes?: CambioMeta[] }>;
}

@Injectable()
export class MetaProvider implements ProveedorWhatsApp {
  private readonly logger = new Logger(MetaProvider.name);

  private readonly accessToken = process.env.META_ACCESS_TOKEN;
  private readonly phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  private readonly verifyToken = process.env.META_VERIFY_TOKEN ?? 'agentkit-verify';
  private readonly apiVersion = process.env.META_API_VERSION ?? 'v25.0';

  /**
   * IDs (wamid) de los mensajes que enviamos nosotros por API.
   * En coexistencia, Meta nos devuelve un eco de TODO lo que sale del
   * número — incluido lo que mandó el propio agente. Sin esta lista
   * el agente se auto-derivaría al responder.
   */
  private readonly wamidsPropios: string[] = [];

  validarWebhook(req: Request): string | null {
    const modo = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (modo === 'subscribe' && token === this.verifyToken && typeof challenge === 'string') {
      return challenge;
    }
    return null;
  }

  parsearWebhook(body: unknown): MensajeEntrante[] {
    const payload = (body ?? {}) as PayloadMeta;
    const mensajes: MensajeEntrante[] = [];

    for (const entry of payload.entry ?? []) {
      for (const cambio of entry.changes ?? []) {
        const valor = cambio.value ?? {};

        this.registrarEstados(valor.statuses ?? []);

        // --- Mensajes entrantes del cliente ---
        for (const msg of valor.messages ?? []) {
          if (msg.type !== 'text') continue;
          const desdePublicidad = msg.referral?.source_type === 'ad';
          mensajes.push({
            telefono: msg.from ?? '',
            texto: msg.text?.body ?? '',
            mensajeId: msg.id ?? '',
            desdePublicidad,
            referralSource: desdePublicidad ? (msg.referral?.source_id ?? '') : '',
            esEchoHumano: false,
          });
        }

        // --- Ecos de coexistencia: alguien respondió desde el celular ---
        if (cambio.field === 'smb_message_echoes') {
          for (const eco of valor.message_echoes ?? []) {
            if (eco.type !== 'text') continue;
            const wamid = eco.id ?? '';
            if (this.esEchoPropio(wamid)) continue; // lo mandó el agente, no una persona
            mensajes.push({
              // En un eco, "to" es el cliente y "from" es el negocio.
              telefono: eco.to ?? '',
              texto: eco.text?.body ?? '',
              mensajeId: wamid,
              desdePublicidad: false,
              referralSource: '',
              esEchoHumano: true,
            });
          }
        }

        // "history" y "smb_app_state_sync" llegan al vincular el número.
        // No los procesamos: el historial previo vive en la app, y volcarlo
        // entero a la memoria del agente traería miles de mensajes sin
        // contexto útil.
        if (cambio.field === 'history' || cambio.field === 'smb_app_state_sync') {
          this.logger.log(`Webhook de sincronización recibido (${cambio.field}), ignorado`);
        }
      }
    }

    return mensajes;
  }

  async enviarMensaje(telefono: string, mensaje: string): Promise<boolean> {
    return this.postMensaje(
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: telefono,
        type: 'text',
        text: { preview_url: false, body: mensaje },
      },
      'texto',
    );
  }

  async enviarPlantilla(
    telefono: string,
    plantilla: string,
    opciones: OpcionesPlantilla = {},
  ): Promise<boolean> {
    const { parametros, parametrosHeader, idioma = 'es' } = opciones;
    const componentes: unknown[] = [];

    if (parametrosHeader) {
      componentes.push({ type: 'header', parameters: this.armarParametros(parametrosHeader) });
    }
    if (parametros) {
      componentes.push({ type: 'body', parameters: this.armarParametros(parametros) });
    }

    const template: Record<string, unknown> = {
      name: plantilla,
      language: { code: idioma },
    };
    if (componentes.length > 0) {
      template.components = componentes;
    }

    return this.postMensaje(
      { messaging_product: 'whatsapp', to: telefono, type: 'template', template },
      `plantilla '${plantilla}'`,
    );
  }

  // --- Internos ---

  /**
   * Convierte los valores al formato de `parameters` que espera la API.
   * Un dict produce parámetros nombrados ({{nombre}}); un array, posicionales
   * ({{1}}, {{2}}) en el orden dado. Mezclarlos falla: una plantilla es
   * NAMED o POSITIONAL, nunca ambas. Todo viaja como texto, también los números.
   */
  private armarParametros(valores: ParametrosPlantilla): unknown[] {
    if (Array.isArray(valores)) {
      return valores.map((valor) => ({ type: 'text', text: String(valor) }));
    }
    return Object.entries(valores).map(([clave, valor]) => ({
      type: 'text',
      parameter_name: clave,
      text: String(valor),
    }));
  }

  private esEchoPropio(wamid: string): boolean {
    return wamid.length > 0 && this.wamidsPropios.includes(wamid);
  }

  private recordarWamid(wamid: string): void {
    this.wamidsPropios.push(wamid);
    if (this.wamidsPropios.length > MAX_WAMIDS_RECORDADOS) {
      this.wamidsPropios.shift();
    }
  }

  /**
   * Los estados de entrega son la única forma de saber por qué un envío
   * aceptado (HTTP 200 + wamid) nunca llegó. Sin esto, un fallo desaparece
   * sin dejar rastro.
   */
  private registrarEstados(estados: EstadoMeta[]): void {
    for (const estado of estados) {
      const destino = estado.recipient_id ?? 'desconocido';
      if (estado.status === 'failed') {
        for (const err of estado.errors ?? [{}]) {
          this.logger.error(
            `Mensaje a ${destino} FALLÓ — código ${err.code}: ${err.title} | ${err.error_data?.details ?? ''}`,
          );
        }
      } else {
        this.logger.log(`Mensaje a ${destino}: ${estado.status}`);
      }
    }
  }

  /** Envía un payload al endpoint /messages y recuerda el wamid resultante. */
  private async postMensaje(payload: unknown, descripcion: string): Promise<boolean> {
    if (!this.accessToken || !this.phoneNumberId) {
      this.logger.warn('META_ACCESS_TOKEN o META_PHONE_NUMBER_ID no configurados');
      return false;
    }

    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;

    try {
      const respuesta = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!respuesta.ok) {
        const detalle = await respuesta.text();
        this.logger.error(
          `Error Meta API al enviar ${descripcion}: ${respuesta.status} — ${detalle}`,
        );
        return false;
      }

      // Guardar el wamid para reconocer nuestro propio eco después.
      const datos = (await respuesta.json()) as { messages?: Array<{ id?: string }> };
      for (const m of datos.messages ?? []) {
        if (m.id) this.recordarWamid(m.id);
      }
      return true;
    } catch (error) {
      this.logger.error(
        `Fallo de red al enviar ${descripcion}: ${(error as Error).message}`,
      );
      return false;
    }
  }
}
