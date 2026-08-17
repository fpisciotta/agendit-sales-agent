// src/memory/entities/recontacto.entity.ts — Registro de recontactos enviados
//
// Existe solo para no perseguir al cliente: si hay una fila para un teléfono,
// ya se le mandó el recontacto y no se le manda otro.

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('recontactos')
export class Recontacto {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 50 })
  telefono!: string;

  @CreateDateColumn()
  timestamp!: Date;
}
