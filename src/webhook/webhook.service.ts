// src/webhook/webhook.service.ts — Orquesta el flujo de un mensaje entrante

import { Inject, Injectable, Logger } from '@nestjs/common';

import { BrainService } from '../brain/brain.service';
import { CalendarService } from '../calendar/calendar.service';
import { desdeHoraNegocio, formatearNegocio, proximoHorarioValido } from '../common/tiempo';
import { MemoryService } from '../memory/memory.service';
import {
  MensajeEntrante,
  PROVEEDOR_WHATSAPP,
  ProveedorWhatsApp,
} from '../providers/whatsapp-provider.interface';

/** Marca que el agente pone en su respuesta cuando decide pasar a un humano. */
const MARCA_DERIVAR = '[DERIVAR_A_HUMANO]';

/**
 * Marca con la que el agente agenda un recontacto futuro.
 * Formato: [RECONTACTAR: 2026-08-24 09:00 | el Plan Premium para tu consultorio]
 * La hora se interpreta en hora de Paraguay y se guarda en UTC.
 */
/**
 * Marca con la que el agente agenda la demo.
 * Formato: [AGENDAR_DEMO: 2026-08-24 14:00 | cliente@mail.com]
 * La hora se interpreta en hora de Paraguay.
 */
const REGEX_DEMO =
  /\[AGENDAR_DEMO:\s*(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s*\|\s*([^\]\s]+)\]/i;

const REGEX_RECONTACTAR =
  /\[RECONTACTAR:\s*(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2}))?\s*\|\s*([^\]]+)\]/i;

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
    private readonly calendar: CalendarService,
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
      // Habilita al agente aunque el número no venga de publicidad: un #on es
      // una persona decidiendo que el agente atienda esta conversación, y eso
      // manda por encima del filtro automático. Sin esto el comando no hace
      // nada visible en esas conversaciones — el agente sigue mudo.
      await this.memory.registrarLeadPublicidad(msg.telefono, 'activado-con-#on');
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

    // El mensaje del equipo se guarda en el historial para que el agente sepa
    // qué se le dijo al cliente, pero NO deriva la conversación.
    //
    // Antes cualquier mensaje del equipo pausaba al agente, y eso rompía el #on:
    // se reactivaba, el equipo escribía una línea más y volvía a quedar mudo.
    // Ahora el agente solo se desactiva de dos formas, ambas explícitas:
    // un #off del equipo, o un [DERIVAR_A_HUMANO] del propio agente.
    await this.memory.guardarMensaje(msg.telefono, 'assistant', msg.texto);
    this.logger.log(`Mensaje del equipo desde la app para ${msg.telefono} (agente sin cambios)`);
  }

  /**
   * Detecta [AGENDAR_DEMO: ...], crea el evento en Google Calendar y devuelve el
   * texto listo para enviar.
   *
   * Si el horario está ocupado NO agenda: reescribe la respuesta ofreciendo los
   * horarios libres. Es la única parte del flujo donde el código pisa lo que
   * escribió el agente, y es a propósito: el agente no puede saber la
   * disponibilidad real, así que su confirmación sería una promesa falsa.
   */
  private async procesarMarcaDemo(respuesta: string, telefono: string): Promise<string> {
    const match = REGEX_DEMO.exec(respuesta);
    if (!match) return respuesta;

    const limpia = respuesta.replace(match[0], '').trim();
    const [, anio, mes, dia, hora, minuto, email] = match;

    const inicio = desdeHoraNegocio(
      Number(anio),
      Number(mes),
      Number(dia),
      Number(hora),
      Number(minuto),
    );

    if (inicio.getTime() <= Date.now()) {
      this.logger.warn(
        `Demo agendada en el pasado (${formatearNegocio(inicio)}) para ${telefono}, se ignora`,
      );
      return limpia;
    }

    const nombre = await this.memory.obtenerNombre(telefono);
    const resultado = await this.calendar.agendarDemo({
      inicio,
      emailCliente: email,
      nombreCliente: nombre || undefined,
      telefono,
    });

    if (resultado.ok) {
      // Con la demo agendada, la conversación pasa al equipo: es un lead
      // caliente y alguien tiene que dar esa reunión.
      await this.memory.derivarAHumano(telefono);
      this.logger.log(`Conversación derivada por demo agendada: ${telefono}`);

      // Acá se notifica SIEMPRE, sin pasar por registrarNotificacion(). Ese
      // control manda un solo aviso por cliente, y una reunión agendada tiene
      // que avisarse aunque a ese cliente ya se lo hubiera derivado antes.
      await this.memory.registrarNotificacion(telefono);
      await this.notificarEquipo(telefono);

      const meet = resultado.meetUrl ? `\n\nEl enlace de la videollamada: ${resultado.meetUrl}` : '';
      return `${limpia}${meet}`;
    }

    if (resultado.alternativas && resultado.alternativas.length > 0) {
      return (
        `Justo a esa hora ya tengo otra demo agendada. ` +
        `Ese mismo día me queda libre a las ${resultado.alternativas.join(', ')}. ` +
        `¿Alguno te sirve, o preferís otro día?`
      );
    }

    if (resultado.alternativas) {
      return (
        `Ese día ya lo tengo completo. ¿Qué otro día te viene bien? ` +
        `Damos demos de lunes a viernes, de 10:00 a 17:00.`
      );
    }

    // Falla técnica: no le prometemos al cliente algo que no se agendó.
    this.logger.error(`No se pudo agendar la demo de ${telefono}: ${resultado.motivo}`);
    return (
      `Tuve un problema para agendar la reunión desde acá. ` +
      `Le paso tus datos al equipo y te confirman el horario en un rato. ` +
      `${MARCA_DERIVAR}`
    );
  }

  /**
   * Detecta la marca [RECONTACTAR: ...], agenda el envío y la saca del texto.
   * Devuelve la respuesta ya limpia para mandarle al cliente.
   */
  private async procesarMarcaRecontacto(respuesta: string, telefono: string): Promise<string> {
    const match = REGEX_RECONTACTAR.exec(respuesta);
    if (!match) return respuesta;

    const limpia = respuesta.replace(match[0], '').trim();
    const [, anio, mes, dia, hora, minuto, contexto] = match;

    // La fecha viene en hora de Paraguay; se convierte a UTC para guardarla.
    const pedida = desdeHoraNegocio(
      Number(anio),
      Number(mes),
      Number(dia),
      hora ? Number(hora) : 9,
      minuto ? Number(minuto) : 0,
    );

    // Si cae de madrugada, se corre al próximo horario razonable.
    const fechaEnvio = proximoHorarioValido(pedida);

    if (fechaEnvio.getTime() <= Date.now()) {
      this.logger.warn(
        `El agente agendó un recontacto en el pasado (${formatearNegocio(fechaEnvio)}) para ${telefono}, se ignora`,
      );
      return limpia;
    }

    await this.memory.programarRecontacto(telefono, fechaEnvio, contexto.trim());
    this.logger.log(
      `Recontacto agendado para ${telefono} el ${formatearNegocio(fechaEnvio)} — ${contexto.trim()}`,
    );
    return limpia;
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

    // Se registra SIEMPRE, tenga nombre o no y aunque el filtro de leads lo
    // descarte más abajo: el padrón de contactos es de quién nos escribió.
    await this.memory.registrarContacto(msg.telefono, msg.nombrePerfil);

    // El cliente escribió: si había un recontacto agendado, ya no hace falta.
    await this.memory.cancelarProgramados(msg.telefono);

    // #on y #off NO se manejan acá a propósito. Son comandos del equipo, que
    // los escribe desde la app WhatsApp Business — y eso llega como eco, no
    // como mensaje del cliente (ver manejarEchoHumano). Un "#on" que entre por
    // esta vía lo escribió el cliente, y no debería poder habilitarse solo ni
    // silenciar al agente: se trata como un mensaje cualquiera.

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

    respuesta = await this.procesarMarcaDemo(respuesta, msg.telefono);
    respuesta = await this.procesarMarcaRecontacto(respuesta, msg.telefono);

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
