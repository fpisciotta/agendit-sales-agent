// src/memory/entities/cliente.entity.ts — Datos del cliente
//
// Por ahora solo el nombre del perfil de WhatsApp, que se usa para
// personalizar las plantillas.

import { Column, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('clientes')
export class Cliente {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 50 })
  telefono!: string;

  @Column({ type: 'varchar', length: 200, default: '' })
  nombre!: string;

  @UpdateDateColumn()
  actualizado!: Date;
}
