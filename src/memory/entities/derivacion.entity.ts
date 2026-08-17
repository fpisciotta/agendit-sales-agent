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

  @UpdateDateColumn()
  timestamp!: Date;
}
