// src/memory/entities/derivacion.entity.ts — Conversaciones derivadas a un humano

import { Column, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('derivaciones')
export class Derivacion {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 50 })
  telefono!: string;

  @Column({ type: 'boolean', default: true })
  activa!: boolean;

  /**
   * True si ya se avisó al equipo por este cliente. No se resetea al reactivar
   * el agente: el aviso se manda una sola vez por cliente, no una vez por
   * derivación.
   */
  @Column({ type: 'boolean', default: false })
  notificado!: boolean;

  @UpdateDateColumn()
  timestamp!: Date;
}
