// src/common/flags.ts — Interruptores de comportamiento leídos del entorno
//
// Viven acá y no en el servicio que los usa porque hay más de un módulo que
// necesita tomar la misma decisión, y dos lecturas separadas de la misma
// variable se desincronizan apenas alguien cambia el valor por defecto.

/**
 * Si está activo, el agente solo atiende y recontacta a números que llegaron
 * por publicidad paga (Click-to-WhatsApp) o que el equipo activó con #on.
 * Poné SOLO_LEADS_PUBLICIDAD=false para poder probar desde tu propio celular.
 */
export const SOLO_LEADS_PUBLICIDAD = process.env.SOLO_LEADS_PUBLICIDAD !== 'false';
