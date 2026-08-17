// src/webhook/webhook.service.ts — Orquesta el flujo de un mensaje entrante

import { Inject, Injectable, Logger } from '@nestjs/common';

import { BrainService } from '../brain/brain.service';
import { MemoryService } from '../memory/memory.service';
import {
  MensajeEntrante,
  PROVEEDOR_WHATSAPP,
  ProveedorWhatsApp,
} from '../providers/whatsapp-provider.interface';

/** Marca que el agente pone en su respuesta cuando decide pasar a un humano. */
const MARCA_DERIVAR = '[DERIVAR_A_HUMANO]';

/**
 * Si está en true, el agente solo responde a números que llegaron por
 * publicidad paga (Click-to-WhatsApp). Poné SOLO_LEADS_PUBLICIDAD=false
 * para atender a cualquiera — necesario para probar desde tu propio celular.
 */
const SOLO_LEADS_PUBLICIDAD = process.env.SOLO_LEADS_PUBLICIDAD !== 'false';

/**
 * Números del equipo que reciben el aviso cuando una conversación se deriva.
 * En formato E.164 sin "+", separados por coma.
 */
const NUMEROS_NOTIFICACION = (process.env.NUMEROS_NOTIFICACION ?? '595972511222,595984489269')
  .split(',')
  .map((numero) => numero.replace(/\D/g, ''))
  .filter((numero) => numero.length > 0);

/** Plantilla aprobada que avisa al equipo. Recibe el número del cliente en el body. */
const PLANTILLA_NOTIFICACION = process.env.PLANTILLA_NOTIFICACION ?? 'sales_agent_notification';
const IDIOMA_NOTIFICACION = process.env.PLANTILLA_NOTIFICACION_IDIOMA ?? 'es';

/**
 * Mensajes que hacen que el agente atienda aunque el número no venga marcado
 * como lead de publicidad.
 *
 * Son las frases que genera un botón de WhatsApp en la web o en un anuncio:
 * el cliente sí viene de una campaña, pero Meta no siempre manda el `referral`
 * que activa el filtro, y sin esto el agente lo ignora en silencio.
 *
 * Se configuran con MENSAJES_DE_ENTRADA, separados por "|".
 */
const MENSAJES_DE_ENTRADA = (
  process.env.MENSAJES_DE_ENTRADA ?? 'hola me interesa saber mas sobre agendit'
)
  .split('|')
  .map((frase) => normalizar(frase))
  .filter((frase) => frase.length > 0);

/**
 * Deja el texto comparable: minúsculas, sin tildes, sin puntuación y con los
 * espacios colapsados. Así "¡Hola! Me interesa saber más sobre Agendit"
 * coincide con "hola me interesa saber mas sobre agendit".
 */
function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // saca los diacríticos que dejó NFD
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // puntuación y emojis → espacio
    .replace(/\s+/g, ' ')
    .trim();
}

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    @Inject(PROVEEDOR_WHATSAPP) private readonly proveedor: ProveedorWhatsApp,
    private readonly brain: BrainService,
    private readonly memory: MemoryService,
  ) {}

  async procesar(body: unknown): Promise<void> {
    const mensajes = this.proveedor.parsearWebhook(body);

    for (const msg of mensajes) {
      if (!msg.texto || !msg.telefono) continue;

      if (msg.esEchoHumano) {
        await this.manejarEchoHumano(msg);
        continue;
      }

      await this.manejarMensajeCliente(msg);
    }
  }

  /**
   * Coexistencia: una persona respondió a mano desde la app WhatsApp Business.
   * El agente se calla en esa conversación hasta que alguien la reactive.
   */
  private async manejarEchoHumano(msg: MensajeEntrante): Promise<void> {
    const comando = msg.texto.trim().toLowerCase();

    // El operador puede devolverle la conversación al agente
    // escribiendo #on desde la misma app.
    if (comando === '#on') {
      await this.memory.reactivarAgente(msg.telefono);
      this.logger.log(`Agente reactivado desde la app: ${msg.telefono}`);
      return;
    }

    // #off es la vía explícita del equipo para tomar la conversación. No se
    // guarda en el historial: es un comando, no algo que le dijimos al cliente.
    // Tampoco notifica — el equipo ya está acá, lo escribió él.
    if (comando === '#off') {
      await this.memory.derivarAHumano(msg.telefono);
      this.logger.log(`Agente desactivado desde la app: ${msg.telefono}`);
      return;
    }

    await this.memory.guardarMensaje(msg.telefono, 'assistant', msg.texto);

    if (!(await this.memory.estaDerivada(msg.telefono))) {
      await this.memory.derivarAHumano(msg.telefono);
      this.logger.log(`Humano respondió desde la app, agente en pausa: ${msg.telefono}`);
    }
  }

  /**
   * Avisa al equipo que una conversación quedó esperando respuesta humana.
   *
   * Va por plantilla y no por texto libre a propósito: los números del equipo
   * casi nunca tienen una ventana de 24 h abierta con el negocio, y un texto
   * libre fuera de esa ventana se acepta con wamid y nunca se entrega.
   *
   * Un fallo acá no puede tumbar la conversación con el cliente: si la
   * notificación no sale, se loguea y el flujo sigue.
   */
  private async notificarEquipo(telefonoCliente: string): Promise<void> {
    if (NUMEROS_NOTIFICACION.length === 0) return;

    const resultados = await Promise.allSettled(
      NUMEROS_NOTIFICACION.map((destino) =>
        this.proveedor.enviarPlantilla(destino, PLANTILLA_NOTIFICACION, {
          parametros: [`+${telefonoCliente}`],
          idioma: IDIOMA_NOTIFICACION,
        }),
      ),
    );

    resultados.forEach((resultado, i) => {
      const destino = NUMEROS_NOTIFICACION[i];
      if (resultado.status === 'fulfilled' && resultado.value) {
        this.logger.log(`Equipo notificado (${destino}) sobre el cliente ${telefonoCliente}`);
      } else {
        const motivo =
          resultado.status === 'rejected' ? (resultado.reason as Error).message : 'la API rechazó el envío';
        this.logger.error(`No se pudo notificar a ${destino}: ${motivo}`);
      }
    });
  }

  /**
   * True si el texto contiene alguna de las frases de MENSAJES_DE_ENTRADA.
   * Va por "contiene" y no por igualdad para tolerar que el cliente agregue
   * algo antes o después de la frase del botón.
   */
  private esMensajeDeEntrada(texto: string): boolean {
    const normalizado = normalizar(texto);
    return MENSAJES_DE_ENTRADA.some((frase) => normalizado.includes(frase));
  }

  private async manejarMensajeCliente(msg: MensajeEntrante): Promise<void> {
    this.logger.log(`Mensaje de ${msg.telefono}: ${msg.texto}`);

    // #on y #off son comandos del EQUIPO, no del cliente. Normalmente se escriben
    // desde la app WhatsApp Business y llegan como eco (ver manejarEchoHumano);
    // acá quedan como respaldo por si alguien los manda desde otro cliente de
    // WhatsApp. Ninguno notifica al equipo: es el equipo el que los escribió.
    const comando = msg.texto.trim().toLowerCase();
    if (comando === '#on') {
      await this.memory.reactivarAgente(msg.telefono);
      this.logger.log(`Agente reactivado para: ${msg.telefono}`);
      return;
    }

    if (comando === '#off') {
      await this.memory.derivarAHumano(msg.telefono);
      this.logger.log(`Agente desactivado para: ${msg.telefono}`);
      return;
    }

    if (msg.desdePublicidad) {
      await this.memory.registrarLeadPublicidad(msg.telefono, msg.referralSource);
      this.logger.log(`Lead de publicidad registrado: ${msg.telefono}`);
    }

    // Un mensaje de entrada vale como lead. Lo registramos, no solo lo dejamos
    // pasar: si no, el filtro volvería a descartar el SEGUNDO mensaje del mismo
    // cliente y la conversación se cortaría después del saludo.
    if (!msg.desdePublicidad && this.esMensajeDeEntrada(msg.texto)) {
      await this.memory.registrarLeadPublicidad(msg.telefono, 'mensaje-de-entrada');
      this.logger.log(`Lead por mensaje de entrada registrado: ${msg.telefono}`);
    }

    if (SOLO_LEADS_PUBLICIDAD && !(await this.memory.esLeadPublicidad(msg.telefono))) {
      this.logger.log(`Número no proviene de publicidad, ignorando: ${msg.telefono}`);
      return;
    }

    // Si la conversación está en manos de un humano, guardamos y no respondemos.
    if (await this.memory.estaDerivada(msg.telefono)) {
      this.logger.log(`Conversación derivada a humano, ignorando: ${msg.telefono}`);
      await this.memory.guardarMensaje(msg.telefono, 'user', msg.texto);
      return;
    }

    // El historial se pide ANTES de guardar el mensaje actual: el brain lo agrega.
    const historial = await this.memory.obtenerHistorial(msg.telefono);
    let respuesta = await this.brain.generarRespuesta(msg.texto, historial);

    if (respuesta.includes(MARCA_DERIVAR)) {
      respuesta = respuesta.replace(MARCA_DERIVAR, '').trim();
      await this.memory.derivarAHumano(msg.telefono);
      this.logger.log(`Conversación derivada a humano: ${msg.telefono}`);

      // Solo la primera derivación de este cliente avisa al equipo.
      if (await this.memory.registrarNotificacion(msg.telefono)) {
        await this.notificarEquipo(msg.telefono);
      } else {
        this.logger.log(`Ya se había notificado al equipo por ${msg.telefono}, no se repite`);
      }
    }

    await this.memory.guardarMensaje(msg.telefono, 'user', msg.texto);
    await this.memory.guardarMensaje(msg.telefono, 'assistant', respuesta);

    await this.proveedor.enviarMensaje(msg.telefono, respuesta);
    this.logger.log(`Respuesta a ${msg.telefono}: ${respuesta}`);
  }
}
