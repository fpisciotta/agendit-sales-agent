// src/memory/entities/recontacto-programado.entity.ts
//
// Cuando el agente promete escribir en una fecha ("te escribo el lunes"),
// se anota acá. El cron lo busca cuando vence y manda la plantilla.

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('recontactos_programados')
export class RecontactoProgramado {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index()
  @Column({ type: 'varchar', length: 50 })
  telefono!: string;

  /**
   * Momento del envío, SIEMPRE en UTC. El agente lo escribe en hora de
   * Paraguay y se convierte al guardarlo (ver common/tiempo.ts).
   */
  @Index()
  @Column({ type: 'datetime' })
  fechaEnvio!: Date;

  /**
   * De qué se hablaba, para el {{2}} de la plantilla.
   * Ej: "el Plan Premium para tu consultorio".
   */
  @Column({ type: 'varchar', length: 300 })
  contexto!: string;

  @Column({ type: 'boolean', default: false })
  enviado!: boolean;

  @CreateDateColumn()
  creado!: Date;
}
