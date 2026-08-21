// src/calendar/calendar.service.ts — Agenda las demos en Google Calendar
//
// Usa una Service Account con delegación de dominio (Google Workspace): la
// cuenta de servicio actúa EN NOMBRE de una persona del dominio, que queda como
// organizadora del evento. No hay tokens que caduquen ni autorizaciones que
// alguien tenga que renovar.
//
// Configuración en Google Cloud + Workspace:
//   1. Crear la Service Account y bajar el JSON de la clave
//   2. Habilitar "Domain-wide delegation" en esa cuenta
//   3. En Admin de Workspace, autorizar su Client ID para el scope
//      https://www.googleapis.com/auth/calendar
//   4. GOOGLE_IMPERSONATE_EMAIL = la persona del dominio dueña del calendario

import { Injectable, Logger } from '@nestjs/common';
// Solo el paquete de Calendar, NO el 'googleapis' completo: ese trae los tipos
// de cientos de APIs de Google y hace que tsc se coma más de 1 GB compilando,
// lo que revienta el build en servidores chicos.
import { auth as googleAuth, calendar as googleCalendar, calendar_v3 } from '@googleapis/calendar';

import {
  TZ_NEGOCIO,
  desdeHoraNegocio,
  esDiaHabil,
  etiquetaSlot,
  formatearNegocio,
  minutosDelDia,
  partesEnNegocio,
} from '../common/tiempo';

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

/** Una franja horaria de atención, en minutos desde la medianoche. */
interface Franja {
  desde: number;
  hasta: number;
}

/** "13" o "13:30" → minutos desde la medianoche. */
function aMinutos(valor: string): number {
  const [h, m] = valor.trim().split(':');
  return Number(h) * 60 + Number(m ?? 0);
}

/** "10-12,13-17" → [{desde:600,hasta:720},{desde:780,hasta:1020}] */
function parsearFranjas(texto: string): Franja[] {
  return texto
    .split(',')
    .map((tramo) => tramo.trim())
    .filter(Boolean)
    .map((tramo) => {
      const [a, b] = tramo.split('-');
      return { desde: aMinutos(a), hasta: aMinutos(b) };
    })
    .filter((f) => f.hasta > f.desde)
    .sort((x, y) => x.desde - y.desde);
}

/**
 * Franjas en las que se dan demos, hora de Paraguay. El corte del mediodía es
 * el almuerzo: no se agenda entre las 12 y las 13.
 */
export const DEMO_FRANJAS: Franja[] = parsearFranjas(process.env.DEMO_FRANJAS ?? '10-12,13-17');

/** Duración de cada demo. También es el paso con el que se ofrecen horarios. */
export const DEMO_DURACION_MIN = Number(process.env.DEMO_DURACION_MIN ?? 30);

/**
 * Anticipación mínima para una demo de hoy. Sin esto, un cliente que escribe
 * a las 14:58 puede agendar a las 15:00 y agarrar al equipo desprevenido.
 */
export const DEMO_ANTICIPACION_MIN = Number(process.env.DEMO_ANTICIPACION_MIN ?? 30);

/** "de 10:00 a 12:00 y de 13:00 a 17:00" — para los mensajes al cliente. */
export function descripcionFranjas(): string {
  const hhmm = (min: number) =>
    `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  const tramos = DEMO_FRANJAS.map((f) => `de ${hhmm(f.desde)} a ${hhmm(f.hasta)}`);
  if (tramos.length <= 1) return tramos[0] ?? '';
  return `${tramos.slice(0, -1).join(', ')} y ${tramos[tramos.length - 1]}`;
}

/** Días hacia adelante que se miran al buscar horarios alternativos. */
const DIAS_A_EXPLORAR = 10;

/** Por qué no se pudo agendar. El webhook elige el mensaje según esto. */
export type RazonRechazo =
  | 'ocupado'
  | 'fin-de-semana'
  | 'fuera-de-franja'
  | 'muy-pronto'
  | 'sin-configurar'
  | 'error';

export interface ResultadoDemo {
  ok: boolean;
  /** Enlace de Google Meet, cuando el evento se creó. */
  meetUrl?: string;
  /** Horarios para ofrecerle al cliente, ya en lenguaje natural. */
  alternativas?: string[];
  razon?: RazonRechazo;
  motivo?: string;
}

@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);
  private readonly calendarId = process.env.GOOGLE_CALENDAR_ID ?? 'primary';
  private readonly impersonar = process.env.GOOGLE_IMPERSONATE_EMAIL ?? '';
  private readonly credenciales = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? '';

  private cliente: calendar_v3.Calendar | null = null;

  /** True si hay configuración suficiente para hablar con Google. */
  get habilitado(): boolean {
    return this.credenciales.length > 0 && this.impersonar.length > 0;
  }

  /**
   * Agenda la demo si el horario es válido y está libre.
   *
   * Cuando no se puede, NO agenda: devuelve alternativas reales para que el
   * agente se las ofrezca. Es preferible a superponer dos demos, o a aceptar
   * un horario en el que no hay nadie, y que después alguien lo reacomode.
   */
  async agendarDemo(params: {
    inicio: Date;
    emailCliente: string;
    nombreCliente?: string;
    telefono: string;
  }): Promise<ResultadoDemo> {
    const { inicio, emailCliente, nombreCliente, telefono } = params;

    if (!this.habilitado) {
      // Ruidoso a propósito: sin esto la demo falla en silencio y el único
      // rastro es que el agente deriva al equipo sin motivo aparente.
      this.logger.error(
        `NO se pudo agendar la demo de ${telefono}: Google Calendar sin configurar` +
          ` (GOOGLE_SERVICE_ACCOUNT_JSON=${this.credenciales ? 'ok' : 'FALTA'},` +
          ` GOOGLE_IMPERSONATE_EMAIL=${this.impersonar || 'FALTA'})`,
      );
      return { ok: false, razon: 'sin-configurar', motivo: 'Google Calendar no configurado' };
    }

    const fin = new Date(inicio.getTime() + DEMO_DURACION_MIN * 60_000);

    try {
      // 1. ¿El horario pedido es uno en el que damos demos?
      const rechazo = this.validarHorario(inicio);
      if (rechazo) {
        const alternativas = await this.proximosLibres(inicio);
        this.logger.log(
          `Demo de ${telefono} el ${formatearNegocio(inicio)} rechazada (${rechazo}), ` +
            `ofrezco: ${alternativas.join(' / ') || 'ninguna'}`,
        );
        return { ok: false, razon: rechazo, alternativas };
      }

      // 2. ¿Está libre la agenda?
      const ocupados = await this.rangosOcupados(this.inicioDelDia(inicio), this.finDelDia(inicio));
      if (this.seSuperpone(inicio, fin, ocupados)) {
        const alternativas = await this.proximosLibres(inicio);
        this.logger.log(
          `Demo ocupada el ${formatearNegocio(inicio)} para ${telefono}, ` +
            `ofrezco: ${alternativas.join(' / ') || 'ninguna'}`,
        );
        return { ok: false, razon: 'ocupado', alternativas };
      }

      const calendar = await this.obtenerCliente();
      const quien = nombreCliente ? `${nombreCliente} (+${telefono})` : `+${telefono}`;

      const evento = await calendar.events.insert({
        calendarId: this.calendarId,
        // Necesario para que Google genere el enlace de Meet.
        conferenceDataVersion: 1,
        sendUpdates: 'all', // manda la invitación por mail al cliente
        requestBody: {
          summary: `Demo Agendit — ${quien}`,
          description: [
            'Demostración del sistema agendada por el agente de ventas.',
            '',
            `Cliente: ${quien}`,
            `WhatsApp: +${telefono}`,
          ].join('\n'),
          start: { dateTime: inicio.toISOString(), timeZone: TZ_NEGOCIO },
          end: { dateTime: fin.toISOString(), timeZone: TZ_NEGOCIO },
          attendees: [{ email: emailCliente }],
          conferenceData: {
            createRequest: {
              // Un ID irrepetible por pedido; Google rechaza los repetidos.
              requestId: `demo-${telefono}-${inicio.getTime()}`,
              conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
          },
          reminders: {
            useDefault: false,
            overrides: [
              { method: 'email', minutes: 60 },
              { method: 'popup', minutes: 10 },
            ],
          },
        },
      });

      const meetUrl =
        evento.data.hangoutLink ??
        evento.data.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri ??
        undefined;

      this.logger.log(
        `Demo agendada el ${formatearNegocio(inicio)} para ${telefono} (${emailCliente}) — ${meetUrl ?? 'sin Meet'}`,
      );
      return { ok: true, meetUrl };
    } catch (error) {
      this.logger.error(`Error agendando la demo de ${telefono}: ${(error as Error).message}`);
      return { ok: false, razon: 'error', motivo: (error as Error).message };
    }
  }

  // --- Reglas de horario ---

  /** Devuelve el motivo del rechazo, o null si el horario sirve. */
  private validarHorario(inicio: Date): RazonRechazo | null {
    if (inicio.getTime() < Date.now() + DEMO_ANTICIPACION_MIN * 60_000) return 'muy-pronto';
    if (!esDiaHabil(inicio)) return 'fin-de-semana';
    if (!this.entraEnFranja(inicio)) return 'fuera-de-franja';
    return null;
  }

  /** La demo entera tiene que caber en una franja, no solo empezar dentro. */
  private entraEnFranja(inicio: Date): boolean {
    const arranca = minutosDelDia(inicio);
    const termina = arranca + DEMO_DURACION_MIN;
    return DEMO_FRANJAS.some((f) => arranca >= f.desde && termina <= f.hasta);
  }

  /**
   * Los próximos horarios libres a partir de la fecha pedida, mirando varios
   * días hacia adelante. Explora días porque el rechazo puede ser justamente
   * que el día pedido no sirve: un sábado, o un lunes ya completo.
   */
  private async proximosLibres(referencia: Date): Promise<string[]> {
    const ahora = new Date();
    // Nunca ofrecer algo anterior a ahora, aunque hayan pedido una fecha pasada.
    const desde = referencia.getTime() > ahora.getTime() ? referencia : ahora;
    const p = partesEnNegocio(desde);

    const ventanaFin = desdeHoraNegocio(p.anio, p.mes, p.dia + DIAS_A_EXPLORAR, 0, 0);
    const ocupados = await this.rangosOcupados(this.inicioDelDia(desde), ventanaFin);

    const libres: string[] = [];

    for (let offset = 0; offset < DIAS_A_EXPLORAR && libres.length < 3; offset++) {
      // Mediodía como referencia del día: lejos de cualquier borde de horario
      // de verano, que podría correr la fecha al convertir.
      const dia = desdeHoraNegocio(p.anio, p.mes, p.dia + offset, 12, 0);
      if (!esDiaHabil(dia)) continue;

      const dp = partesEnNegocio(dia);

      for (const franja of DEMO_FRANJAS) {
        for (
          let min = franja.desde;
          min + DEMO_DURACION_MIN <= franja.hasta && libres.length < 3;
          min += DEMO_DURACION_MIN
        ) {
          const slot = desdeHoraNegocio(dp.anio, dp.mes, dp.dia, Math.floor(min / 60), min % 60);
          const finSlot = new Date(slot.getTime() + DEMO_DURACION_MIN * 60_000);

          if (this.validarHorario(slot)) continue; // respeta la anticipación mínima
          if (this.seSuperpone(slot, finSlot, ocupados)) continue;

          libres.push(etiquetaSlot(slot, ahora));
        }
      }
    }

    return libres;
  }

  // --- Internos ---

  private async obtenerCliente(): Promise<calendar_v3.Calendar> {
    if (this.cliente) return this.cliente;

    // Acepta el JSON completo en la variable o una ruta al archivo.
    const credenciales = this.credenciales.trim().startsWith('{')
      ? JSON.parse(this.credenciales)
      : JSON.parse((await import('node:fs')).readFileSync(this.credenciales, 'utf8'));

    const auth = new googleAuth.JWT({
      email: credenciales.client_email,
      key: credenciales.private_key,
      scopes: SCOPES,
      // La delegación de dominio: la Service Account actúa como esta persona.
      subject: this.impersonar,
    });

    this.cliente = googleCalendar({ version: 'v3', auth });
    return this.cliente;
  }

  private async rangosOcupados(desde: Date, hasta: Date): Promise<Array<{ i: number; f: number }>> {
    const calendar = await this.obtenerCliente();
    const res = await calendar.freebusy.query({
      requestBody: {
        timeMin: desde.toISOString(),
        timeMax: hasta.toISOString(),
        timeZone: TZ_NEGOCIO,
        items: [{ id: this.calendarId }],
      },
    });

    const ocupados = res.data.calendars?.[this.calendarId]?.busy ?? [];
    return ocupados
      .filter((r) => r.start && r.end)
      .map((r) => ({ i: new Date(r.start!).getTime(), f: new Date(r.end!).getTime() }));
  }

  private seSuperpone(inicio: Date, fin: Date, ocupados: Array<{ i: number; f: number }>): boolean {
    const i = inicio.getTime();
    const f = fin.getTime();
    return ocupados.some((r) => i < r.f && f > r.i);
  }

  private inicioDelDia(fecha: Date): Date {
    const p = partesEnNegocio(fecha);
    return desdeHoraNegocio(p.anio, p.mes, p.dia, 0, 0);
  }

  private finDelDia(fecha: Date): Date {
    const p = partesEnNegocio(fecha);
    return desdeHoraNegocio(p.anio, p.mes, p.dia + 1, 0, 0);
  }
}
