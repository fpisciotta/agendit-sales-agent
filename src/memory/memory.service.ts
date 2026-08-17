// src/memory/memory.service.ts — Memoria de conversaciones, derivaciones y leads

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Derivacion } from './entities/derivacion.entity';
import { LeadPublicidad } from './entities/lead-publicidad.entity';
import { Mensaje, RolMensaje } from './entities/mensaje.entity';

/** Mensaje en el formato que espera la API de Anthropic. */
export interface TurnoConversacion {
  role: RolMensaje;
  content: string;
}

@Injectable()
export class MemoryService {
  constructor(
    @InjectRepository(Mensaje)
    private readonly mensajes: Repository<Mensaje>,
    @InjectRepository(Derivacion)
    private readonly derivaciones: Repository<Derivacion>,
    @InjectRepository(LeadPublicidad)
    private readonly leads: Repository<LeadPublicidad>,
  ) {}

  async guardarMensaje(telefono: string, role: RolMensaje, content: string): Promise<void> {
    await this.mensajes.save(this.mensajes.create({ telefono, role, content }));
  }

  /**
   * Últimos N mensajes de una conversación, en orden cronológico.
   * No incluye el mensaje actual — el brain lo agrega aparte.
   */
  async obtenerHistorial(telefono: string, limite = 20): Promise<TurnoConversacion[]> {
    const filas = await this.mensajes.find({
      where: { telefono },
      order: { timestamp: 'DESC', id: 'DESC' },
      take: limite,
    });
    return filas.reverse().map(({ role, content }) => ({ role, content }));
  }

  async limpiarHistorial(telefono: string): Promise<void> {
    await this.mensajes.delete({ telefono });
  }

  // --- Derivación a humano ---

  /** Marca la conversación como atendida por una persona. El agente se calla. */
  async derivarAHumano(telefono: string): Promise<void> {
    const existente = await this.derivaciones.findOne({ where: { telefono } });
    if (existente) {
      existente.activa = true;
      await this.derivaciones.save(existente);
      return;
    }
    await this.derivaciones.save(this.derivaciones.create({ telefono, activa: true }));
  }

  async estaDerivada(telefono: string): Promise<boolean> {
    const count = await this.derivaciones.count({ where: { telefono, activa: true } });
    return count > 0;
  }

  /**
   * Marca que ya se avisó al equipo por este cliente y devuelve si el aviso
   * corresponde enviarse ahora.
   *
   * Solo la PRIMERA derivación notifica. Si después alguien reactiva el agente
   * con #on y la conversación vuelve a derivarse, no se avisa de nuevo: el
   * equipo ya tiene a este cliente en el radar.
   *
   * Devuelve false si no hay derivación registrada — llamalo después de
   * derivarAHumano().
   */
  async registrarNotificacion(telefono: string): Promise<boolean> {
    const derivacion = await this.derivaciones.findOne({ where: { telefono } });
    if (!derivacion || derivacion.notificado) return false;

    derivacion.notificado = true;
    await this.derivaciones.save(derivacion);
    return true;
  }

  async reactivarAgente(telefono: string): Promise<void> {
    await this.derivaciones.update({ telefono }, { activa: false });
  }

  // --- Leads de publicidad ---

  async registrarLeadPublicidad(telefono: string, referralSource = ''): Promise<void> {
    const existente = await this.leads.findOne({ where: { telefono } });
    if (existente) return;
    await this.leads.save(this.leads.create({ telefono, referralSource }));
  }

  async esLeadPublicidad(telefono: string): Promise<boolean> {
    const count = await this.leads.count({ where: { telefono } });
    return count > 0;
  }
}
