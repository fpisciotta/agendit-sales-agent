// src/followup/followup.service.ts — Recontacto de conversaciones sin respuesta

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { BrainService } from '../brain/brain.service';
import { SOLO_LEADS_PUBLICIDAD } from '../common/flags';
import { HORA_MAX, HORA_MIN, enHorarioComercial, formatearNegocio } from '../common/tiempo';
import { MemoryService } from '../memory/memory.service';
import { PROVEEDOR_WHATSAPP, ProveedorWhatsApp } from '../providers/whatsapp-provider.interface';

const HORA_MS = 60 * 60 * 1000;

/** Silencio mínimo antes de recontactar. */
const ESPERA_HORAS = Number(process.env.RECONTACTO_HORAS ?? 1);

/**
 * Silencio máximo. Existe por la ventana de 24 h de WhatsApp: pasada esa
 * ventana solo se puede escribir con plantilla, y un texto libre se acepta con
 * wamid pero nunca se entrega. 23 h deja margen para el desfase del cron.
 */
const VENTANA_MAXIMA_HORAS = Number(process.env.RECONTACTO_VENTANA_HORAS ?? 23);

/** Tope por corrida, para no vaciar la cuota del modelo de un saque. */
const MAX_POR_CORRIDA = Number(process.env.RECONTACTO_MAX_POR_CORRIDA ?? 20);

const ACTIVO = process.env.RECONTACTO_ACTIVO !== 'false';

/** Plantilla para los recontactos agendados a fecha futura (fuera de la ventana de 24 h). */
const PLANTILLA_RECONTACTO = process.env.PLANTILLA_RECONTACTO ?? 'recontact';
const IDIOMA_RECONTACTO = process.env.PLANTILLA_RECONTACTO_IDIOMA ?? 'es';

@Injectable()
export class FollowupService {
  private readonly logger = new Logger(FollowupService.name);

  constructor(
    @Inject(PROVEEDOR_WHATSAPP) private readonly proveedor: ProveedorWhatsApp,
    private readonly brain: BrainService,
    private readonly memory: MemoryService,
  ) {}

  /**
   * Corre cada 15 minutos, no cada hora: así una conversación que cumple la
   * hora de silencio se recontacta dentro de los 15 minutos siguientes, en vez
   * de esperar hasta 59 minutos de más.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async recontactarPendientes(): Promise<void> {
    if (!ACTIVO) return;

    // Nadie quiere un mensaje comercial a las 3 de la mañana. La franja se
    // evalúa en hora de Paraguay, no en la del servidor (que corre en UTC).
    const ahora = new Date();
    if (!enHorarioComercial(ahora)) {
      this.logger.debug(
        `Fuera de horario (${formatearNegocio(ahora)}, franja ${HORA_MIN}-${HORA_MAX}), no se recontacta`,
      );
      return;
    }

    const candidatos = await this.memory.telefonosParaRecontactar(
      ESPERA_HORAS * HORA_MS,
      VENTANA_MAXIMA_HORAS * HORA_MS,
    );

    if (candidatos.length === 0) return;

    const aRecontactar = candidatos.slice(0, MAX_POR_CORRIDA);
    this.logger.log(
      `Recontacto: ${candidatos.length} conversación(es) sin respuesta, proceso ${aRecontactar.length}`,
    );

    for (const telefono of aRecontactar) {
      await this.recontactar(telefono);
    }

    if (candidatos.length > aRecontactar.length) {
      this.logger.log(
        `Quedaron ${candidatos.length - aRecontactar.length} para la próxima corrida`,
      );
    }
  }

  /**
   * Envía los recontactos que el agente agendó para una fecha futura
   * ("te escribo el lunes").
   *
   * Van SIEMPRE por plantilla: a esa altura pasaron más de 24 h desde el último
   * mensaje del cliente, y fuera de esa ventana un texto libre se acepta con
   * wamid pero nunca se entrega.
   *
   * Ojo: mandar la plantilla no abre la ventana. La abre el cliente cuando
   * responde — y ahí el webhook lo trata como un mensaje normal, con todo el
   * historial disponible.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async enviarRecontactosProgramados(): Promise<void> {
    if (!ACTIVO) return;

    const ahora = new Date();
    if (!enHorarioComercial(ahora)) return;

    const vencidos = await this.memory.programadosVencidos(ahora);
    if (vencidos.length === 0) return;

    this.logger.log(`Recontactos programados vencidos: ${vencidos.length}`);

    for (const programado of vencidos) {
      const { id, telefono, contexto } = programado;
      try {
        // Si la conversación se derivó mientras tanto, la atiende una persona.
        if (await this.memory.estaDerivada(telefono)) {
          await this.memory.marcarProgramadoEnviado(id);
          this.logger.log(`Recontacto de ${telefono} cancelado: la conversación está derivada`);
          continue;
        }

        // Mismo criterio que en todo el resto: al que el agente no atiende,
        // tampoco le escribe primero.
        if (SOLO_LEADS_PUBLICIDAD && !(await this.memory.esLeadPublicidad(telefono))) {
          await this.memory.marcarProgramadoEnviado(id);
          this.logger.log(`Recontacto de ${telefono} cancelado: no es lead de publicidad`);
          continue;
        }

        // Se marca ANTES de enviar: si el envío falla, preferimos perder un
        // recontacto a mandar dos en la próxima corrida.
        await this.memory.marcarProgramadoEnviado(id);

        // La plantilla lleva un solo parámetro: el tema que quedó pendiente.
        // El saludo es genérico a propósito, así no depende de tener el nombre.
        const enviado = await this.proveedor.enviarPlantilla(telefono, PLANTILLA_RECONTACTO, {
          parametros: [contexto],
          idioma: IDIOMA_RECONTACTO,
        });

        if (enviado) {
          this.logger.log(`Recontacto programado enviado a ${telefono} — ${contexto}`);
        } else {
          this.logger.error(`Falló la plantilla de recontacto para ${telefono}`);
        }
      } catch (error) {
        this.logger.error(
          `Error en el recontacto programado de ${telefono}: ${(error as Error).message}`,
        );
      }
    }
  }

  private async recontactar(telefono: string): Promise<void> {
    try {
      const historial = await this.memory.obtenerHistorial(telefono);
      const mensaje = await this.brain.generarRecontacto(historial);

      if (!mensaje) {
        this.logger.warn(`No se pudo generar el recontacto para ${telefono}, se omite`);
        return;
      }

      // Se registra ANTES de enviar: si el envío falla, preferimos perder un
      // recontacto a mandarle dos mensajes al cliente en la próxima corrida.
      await this.memory.registrarRecontacto(telefono);

      const enviado = await this.proveedor.enviarMensaje(telefono, mensaje);
      if (!enviado) {
        this.logger.error(`Falló el envío del recontacto a ${telefono}`);
        return;
      }

      await this.memory.guardarMensaje(telefono, 'assistant', mensaje);
      this.logger.log(`Recontacto enviado a ${telefono}: ${mensaje.slice(0, 80)}`);
    } catch (error) {
      this.logger.error(`Error recontactando a ${telefono}: ${(error as Error).message}`);
    }
  }
}
