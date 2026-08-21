// src/memory/memory.service.ts — Memoria de conversaciones, derivaciones y leads

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SOLO_LEADS_PUBLICIDAD } from '../common/flags';
import { Cliente } from './entities/cliente.entity';
import { Derivacion } from './entities/derivacion.entity';
import { LeadPublicidad } from './entities/lead-publicidad.entity';
import { Mensaje, RolMensaje } from './entities/mensaje.entity';
import { RecontactoProgramado } from './entities/recontacto-programado.entity';
import { Recontacto } from './entities/recontacto.entity';

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
    @InjectRepository(Recontacto)
    private readonly recontactos: Repository<Recontacto>,
    @InjectRepository(Cliente)
    private readonly clientes: Repository<Cliente>,
    @InjectRepository(RecontactoProgramado)
    private readonly programados: Repository<RecontactoProgramado>,
  ) {}

  // --- Datos del cliente ---

  /**
   * Registra el contacto. Se llama con CADA mensaje que entra, incluso si el
   * filtro de leads después lo descarta: queremos el padrón completo de quién
   * nos escribió, no solo de a quién le contestamos.
   *
   * El nombre es opcional — Meta no siempre lo manda. Si llega vacío se guarda
   * igual el número, y si más adelante aparece el nombre se completa. Un nombre
   * existente nunca se pisa con vacío.
   */
  async registrarContacto(telefono: string, nombre = ''): Promise<void> {
    const limpio = nombre.trim();
    const existente = await this.clientes.findOne({ where: { telefono } });

    if (!existente) {
      await this.clientes.save(this.clientes.create({ telefono, nombre: limpio }));
      return;
    }

    if (limpio && existente.nombre !== limpio) {
      existente.nombre = limpio;
      await this.clientes.save(existente);
    }
  }

  /** Todos los contactos que escribieron alguna vez, del más reciente al más viejo. */
  async listarContactos(): Promise<Cliente[]> {
    return this.clientes.find({ order: { actualizado: 'DESC' } });
  }

  async obtenerNombre(telefono: string): Promise<string> {
    const cliente = await this.clientes.findOne({ where: { telefono } });
    return cliente?.nombre ?? '';
  }

  // --- Recontacto programado (el agente prometió escribir tal día) ---

  /**
   * Agenda un recontacto. `fechaEnvio` tiene que venir ya convertida a UTC.
   * Si ya había uno pendiente para ese teléfono, se reemplaza: vale la última
   * promesa que hizo el agente.
   */
  async programarRecontacto(telefono: string, fechaEnvio: Date, contexto: string): Promise<void> {
    await this.programados.delete({ telefono, enviado: false });
    await this.programados.save(
      this.programados.create({ telefono, fechaEnvio, contexto, enviado: false }),
    );
  }

  /** Recontactos cuya fecha ya pasó y siguen sin enviarse. */
  async programadosVencidos(ahora = new Date()): Promise<RecontactoProgramado[]> {
    const pendientes = await this.programados.find({ where: { enviado: false } });
    // El filtro va en JS y no en el WHERE por lo mismo que en
    // telefonosParaRecontactar: en SQLite las fechas son texto y comparar
    // contra un parámetro Date depende del formato de serialización.
    return pendientes.filter((p) => new Date(p.fechaEnvio).getTime() <= ahora.getTime());
  }

  async marcarProgramadoEnviado(id: number): Promise<void> {
    await this.programados.update({ id }, { enviado: true });
  }

  /** Cancela lo agendado: si el cliente escribió, la promesa ya no aplica. */
  async cancelarProgramados(telefono: string): Promise<void> {
    await this.programados.delete({ telefono, enviado: false });
  }

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

  // --- Recontacto ---

  /**
   * Conversaciones que quedaron esperando: el último mensaje lo mandó el agente,
   * pasó el tiempo de espera y el cliente nunca contestó.
   *
   * Excluye las derivadas (las atiende una persona) y las ya recontactadas
   * (no perseguimos al cliente).
   *
   * @param minInactividadMs Cuánto silencio hace falta para recontactar.
   * @param maxInactividadMs Techo de silencio. Existe por la ventana de 24 h de
   *   WhatsApp: pasada esa ventana un texto libre se acepta pero no se entrega,
   *   así que más allá de este límite no tiene sentido intentarlo.
   */
  async telefonosParaRecontactar(
    minInactividadMs: number,
    maxInactividadMs: number,
  ): Promise<string[]> {
    const ahora = Date.now();

    const filas = await this.mensajes
      .createQueryBuilder('m')
      .select('DISTINCT m.telefono', 'telefono')
      .getRawMany<{ telefono: string }>();

    const candidatos: string[] = [];

    for (const { telefono } of filas) {
      // Se pide la entidad y no un MAX() crudo por una razón concreta: SQLite
      // guarda las fechas como texto sin zona horaria, y `new Date(ese string)`
      // lo interpreta como hora local aunque esté en UTC. En GMT-3 eso son 3
      // horas de desfase, suficiente para que una conversación de 2 h de
      // silencio calcule inactividad negativa y no se recontacte nunca.
      // El campo `timestamp` de la entidad ya viene hidratado como Date por
      // TypeORM, así que la cuenta es correcta en cualquier motor.
      const ultimoMensaje = await this.mensajes.findOne({
        where: { telefono },
        order: { timestamp: 'DESC', id: 'DESC' },
      });
      if (!ultimoMensaje) continue;

      // Si el último mensaje es del cliente, o le debemos una respuesta o la
      // conversación siguió su curso: en ninguno de los dos casos recontactamos.
      if (ultimoMensaje.role !== 'assistant') continue;

      const inactividad = ahora - ultimoMensaje.timestamp.getTime();
      if (inactividad < minInactividadMs || inactividad > maxInactividadMs) continue;

      if (await this.estaDerivada(telefono)) continue;
      if (await this.yaSeRecontacto(telefono)) continue;

      // Mismo criterio que para responder: si el agente no atiende a este
      // número, tampoco tiene por qué escribirle primero. Sin esto, cualquier
      // conversación guardada — incluidas las del propio equipo — recibía el
      // recontacto de la hora.
      if (SOLO_LEADS_PUBLICIDAD && !(await this.esLeadPublicidad(telefono))) continue;

      candidatos.push(telefono);
    }

    return candidatos;
  }

  async yaSeRecontacto(telefono: string): Promise<boolean> {
    return (await this.recontactos.count({ where: { telefono } })) > 0;
  }

  /**
   * Deja constancia del recontacto. Se llama ANTES de enviar: si el envío falla,
   * preferimos perder un recontacto a mandar dos por un reintento.
   */
  async registrarRecontacto(telefono: string): Promise<void> {
    if (await this.yaSeRecontacto(telefono)) return;
    await this.recontactos.save(this.recontactos.create({ telefono }));
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
