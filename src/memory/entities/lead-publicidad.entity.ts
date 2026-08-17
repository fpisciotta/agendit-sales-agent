// src/memory/entities/lead-publicidad.entity.ts — Números que llegaron por publicidad paga

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('leads_publicidad')
export class LeadPublicidad {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 50 })
  telefono!: string;

  @Column({ type: 'varchar', length: 200, default: '' })
  referralSource!: string;

  @CreateDateColumn()
  timestamp!: Date;
}
