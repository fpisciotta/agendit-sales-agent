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
import { calendar_v3, google } from 'googleapis';

import { TZ_NEGOCIO, desdeHoraNegocio, formatearNegocio, partesEnNegocio } from '../common/tiempo';

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

/** Franja en la que se dan demos, hora de Paraguay. */
export const DEMO_HORA_MIN = Number(process.env.DEMO_HORA_MIN ?? 10);
export const DEMO_HORA_MAX = Number(process.env.DEMO_HORA_MAX ?? 17);
export const DEMO_DURACION_MIN = Number(process.env.DEMO_DURACION_MIN ?? 30);

export interface ResultadoDemo {
  ok: boolean;
  /** Enlace de Google Meet, cuando el evento se creó. */
  meetUrl?: string;
  /** Alternativas en hora de Paraguay ("14:00"), cuando el horario estaba ocupado. */
  alternativas?: string[];
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
   * Agenda la demo si el horario está libre.
   *
   * Si está ocupado NO agenda: devuelve alternativas del mismo día para que el
   * agente se las ofrezca. Es preferible a superponer dos demos y que alguien
   * las tenga que reacomodar a mano.
   */
  async agendarDemo(params: {
    inicio: Date;
    emailCliente: string;
    nombreCliente?: string;
    telefono: string;
  }): Promise<ResultadoDemo> {
    if (!this.habilitado) {
      return { ok: false, motivo: 'Google Calendar no configurado' };
    }

    const { inicio, emailCliente, nombreCliente, telefono } = params;
    const fin = new Date(inicio.getTime() + DEMO_DURACION_MIN * 60_000);

    try {
      const ocupados = await this.rangosOcupados(this.inicioDelDia(inicio), this.finDelDia(inicio));

      if (this.seSuperpone(inicio, fin, ocupados)) {
        const alternativas = this.slotsLibres(inicio, ocupados);
        this.logger.log(
          `Demo ocupada el ${formatearNegocio(inicio)} para ${telefono}, ofrezco: ${alternativas.join(', ') || 'ninguna'}`,
        );
        return { ok: false, alternativas, motivo: 'horario ocupado' };
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
      return { ok: false, motivo: (error as Error).message };
    }
  }

  // --- Internos ---

  private async obtenerCliente(): Promise<calendar_v3.Calendar> {
    if (this.cliente) return this.cliente;

    // Acepta el JSON completo en la variable o una ruta al archivo.
    const credenciales = this.credenciales.trim().startsWith('{')
      ? JSON.parse(this.credenciales)
      : JSON.parse((await import('node:fs')).readFileSync(this.credenciales, 'utf8'));

    const auth = new google.auth.JWT({
      email: credenciales.client_email,
      key: credenciales.private_key,
      scopes: SCOPES,
      // La delegación de dominio: la Service Account actúa como esta persona.
      subject: this.impersonar,
    });

    this.cliente = google.calendar({ version: 'v3', auth });
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

  /** Horarios libres del mismo día, dentro de la franja de demos. */
  private slotsLibres(referencia: Date, ocupados: Array<{ i: number; f: number }>): string[] {
    const p = partesEnNegocio(referencia);
    const libres: string[] = [];
    const ahora = Date.now();

    for (let hora = DEMO_HORA_MIN; hora < DEMO_HORA_MAX; hora++) {
      const inicio = desdeHoraNegocio(p.anio, p.mes, p.dia, hora, 0);
      const fin = new Date(inicio.getTime() + DEMO_DURACION_MIN * 60_000);
      if (inicio.getTime() <= ahora) continue; // ya pasó
      if (this.seSuperpone(inicio, fin, ocupados)) continue;
      libres.push(`${String(hora).padStart(2, '0')}:00`);
    }
    return libres.slice(0, 3);
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
