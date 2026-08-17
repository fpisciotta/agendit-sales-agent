// src/memory/entities/mensaje.entity.ts — Historial de conversación

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type RolMensaje = 'user' | 'assistant';

@Entity('mensajes')
export class Mensaje {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index()
  @Column({ type: 'varchar', length: 50 })
  telefono!: string;

  @Column({ type: 'varchar', length: 20 })
  role!: RolMensaje;

  @Column({ type: 'text' })
  content!: string;

  @CreateDateColumn()
  timestamp!: Date;
}
