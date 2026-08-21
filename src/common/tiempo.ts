// src/common/tiempo.ts — Manejo de fechas y zona horaria
//
// Regla del proyecto: en la base TODO se guarda en UTC (main.ts fuerza
// process.env.TZ = 'UTC' antes de arrancar). La zona horaria del negocio se
// aplica solo en los bordes: decidir a qué hora se manda algo, y mostrar
// fechas en los logs.
//
// Motivo: el servidor de producción corre en UTC y la máquina de desarrollo en
// GMT-3. Sin esta separación, la misma fecha significa cosas distintas según
// dónde corra el proceso — y eso ya nos rompió el cálculo de inactividad del
// recontacto una vez.

/** Zona del negocio. Paraguay es UTC-3 (dejó de usar horario de verano en 2024). */
export const TZ_NEGOCIO = process.env.TZ_NEGOCIO ?? 'America/Asuncion';

/** Franja en la que es aceptable escribirle a un cliente, en hora del negocio. */
export const HORA_MIN = Number(process.env.RECONTACTO_HORA_MIN ?? 8);
export const HORA_MAX = Number(process.env.RECONTACTO_HORA_MAX ?? 20);

interface PartesFecha {
  anio: number;
  mes: number;
  dia: number;
  hora: number;
  minuto: number;
  segundo: number;
}

/** Descompone un instante en sus componentes según la zona del negocio. */
export function partesEnNegocio(fecha: Date, tz = TZ_NEGOCIO): PartesFecha {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(fecha);

  const valor = (tipo: string): number => {
    const p = partes.find((parte) => parte.type === tipo)?.value ?? '0';
    // Intl puede devolver "24" para medianoche en hour12:false
    return Number(p) % (tipo === 'hour' ? 24 : Number.MAX_SAFE_INTEGER);
  };

  return {
    anio: valor('year'),
    mes: valor('month'),
    dia: valor('day'),
    hora: valor('hour'),
    minuto: valor('minute'),
    segundo: valor('second'),
  };
}

/** Diferencia entre la zona del negocio y UTC, en ms, para ese instante. */
function offsetNegocioMs(fecha: Date, tz = TZ_NEGOCIO): number {
  const p = partesEnNegocio(fecha, tz);
  const comoSiFueraUtc = Date.UTC(p.anio, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
  return comoSiFueraUtc - fecha.getTime();
}

/**
 * Convierte una fecha y hora EXPRESADAS EN HORA DEL NEGOCIO al instante UTC
 * que les corresponde.
 *
 * Ejemplo: desdeHoraNegocio(2026, 8, 24, 9, 0) devuelve el Date de las 09:00
 * de Asunción, que en UTC son las 12:00. Guardar eso es lo correcto; guardar
 * "09:00" a secas haría que en el servidor (UTC) el mensaje salga a las 6 de
 * la mañana hora Paraguay.
 */
export function desdeHoraNegocio(
  anio: number,
  mes: number,
  dia: number,
  hora = 9,
  minuto = 0,
  tz = TZ_NEGOCIO,
): Date {
  const tentativo = Date.UTC(anio, mes - 1, dia, hora, minuto);
  // Dos pasadas: la primera estima el offset, la segunda lo corrige si la
  // estimación cayó del otro lado de un cambio de horario.
  let resultado = new Date(tentativo - offsetNegocioMs(new Date(tentativo), tz));
  resultado = new Date(tentativo - offsetNegocioMs(resultado, tz));
  return resultado;
}

/** True si el instante cae dentro de la franja horaria del negocio. */
export function enHorarioComercial(fecha: Date, tz = TZ_NEGOCIO): boolean {
  const { hora } = partesEnNegocio(fecha, tz);
  return hora >= HORA_MIN && hora < HORA_MAX;
}

/**
 * Corre la fecha al próximo momento dentro de la franja horaria.
 * Si ya está dentro, la devuelve igual.
 *
 * Evita que un "te escribo mañana" generado a las 23:00 dispare de madrugada.
 */
export function proximoHorarioValido(fecha: Date, tz = TZ_NEGOCIO): Date {
  if (enHorarioComercial(fecha, tz)) return fecha;

  const p = partesEnNegocio(fecha, tz);

  // Antes de abrir: mismo día a la hora de apertura.
  if (p.hora < HORA_MIN) {
    return desdeHoraNegocio(p.anio, p.mes, p.dia, HORA_MIN, 0, tz);
  }

  // Después de cerrar: día siguiente a la hora de apertura.
  //
  // Se suma 1 al día EN HORA DEL NEGOCIO. Sumar 24 h en UTC y reconvertir da
  // mal: las 00:00 UTC del día siguiente son todavía las 21:00 del día
  // anterior en Paraguay, así que el mensaje se reprogramaba para el mismo día.
  // Date.UTC normaliza solo el desborde de día 32 → mes siguiente.
  return desdeHoraNegocio(p.anio, p.mes, p.dia + 1, HORA_MIN, 0, tz);
}

/** Formatea un instante en hora del negocio, para los logs. */
export function formatearNegocio(fecha: Date, tz = TZ_NEGOCIO): string {
  const p = partesEnNegocio(fecha, tz);
  const dosDigitos = (n: number) => String(n).padStart(2, '0');
  return (
    `${p.anio}-${dosDigitos(p.mes)}-${dosDigitos(p.dia)} ` +
    `${dosDigitos(p.hora)}:${dosDigitos(p.minuto)}`
  );
}

/**
 * Descripción de "ahora" en hora del negocio, para inyectar en el prompt.
 *
 * El agente necesita saber qué día es para resolver "el lunes", "mañana" o
 * "la semana que viene" y escribir la fecha correcta en la etiqueta
 * [RECONTACTAR: ...]. Sin esto inventa fechas.
 */
export function contextoTemporal(ahora = new Date(), tz = TZ_NEGOCIO): string {
  const fmt = (opciones: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('es-PY', { timeZone: tz, ...opciones }).format(ahora);

  const diaSemana = fmt({ weekday: 'long' });
  const legible = fmt({ day: 'numeric', month: 'long', year: 'numeric' });
  const p = partesEnNegocio(ahora, tz);
  const dosDigitos = (n: number) => String(n).padStart(2, '0');
  const iso = `${p.anio}-${dosDigitos(p.mes)}-${dosDigitos(p.dia)}`;
  const hora = `${dosDigitos(p.hora)}:${dosDigitos(p.minuto)}`;

  return [
    '## Fecha y hora actual',
    `Hoy es ${diaSemana} ${legible} (${iso}) y son las ${hora}, hora de Paraguay.`,
    '',
    'Usá esta fecha para resolver cualquier referencia temporal del cliente',
    '("el lunes", "mañana", "la semana que viene") y para escribir la fecha',
    'de la etiqueta [RECONTACTAR: ...]. Nunca la inventes ni la supongas.',
  ].join('\n');
}

/**
 * Día de la semana en la zona del negocio: 0 = domingo … 6 = sábado.
 *
 * No sirve `fecha.getDay()`: el proceso corre en UTC, y un sábado a las 21:00
 * de Paraguay ya es domingo en UTC. Eso haría rechazar como fin de semana un
 * viernes por la noche, o aceptar un sábado temprano.
 */
export function diaSemanaNegocio(fecha: Date, tz = TZ_NEGOCIO): number {
  const p = partesEnNegocio(fecha, tz);
  return new Date(Date.UTC(p.anio, p.mes - 1, p.dia)).getUTCDay();
}

/** True si la fecha cae de lunes a viernes en la zona del negocio. */
export function esDiaHabil(fecha: Date, tz = TZ_NEGOCIO): boolean {
  const dia = diaSemanaNegocio(fecha, tz);
  return dia >= 1 && dia <= 5;
}

/** Minutos transcurridos desde la medianoche, en hora del negocio. */
export function minutosDelDia(fecha: Date, tz = TZ_NEGOCIO): number {
  const p = partesEnNegocio(fecha, tz);
  return p.hora * 60 + p.minuto;
}

/** True si las dos fechas caen el mismo día del calendario del negocio. */
export function mismoDia(a: Date, b: Date, tz = TZ_NEGOCIO): boolean {
  const x = partesEnNegocio(a, tz);
  const y = partesEnNegocio(b, tz);
  return x.anio === y.anio && x.mes === y.mes && x.dia === y.dia;
}

/**
 * Etiqueta corta y natural para ofrecerle un horario al cliente:
 * "hoy a las 15:00", "mañana a las 10:00", "el mié 26 a las 10:00".
 */
export function etiquetaSlot(slot: Date, ahora = new Date(), tz = TZ_NEGOCIO): string {
  const p = partesEnNegocio(slot, tz);
  const hora = `${String(p.hora).padStart(2, '0')}:${String(p.minuto).padStart(2, '0')}`;

  if (mismoDia(slot, ahora, tz)) return `hoy a las ${hora}`;

  const manana = new Date(ahora.getTime() + 24 * 60 * 60 * 1000);
  if (mismoDia(slot, manana, tz)) return `mañana a las ${hora}`;

  const dia = new Intl.DateTimeFormat('es', { timeZone: tz, weekday: 'short' }).format(slot);
  return `el ${dia.replace('.', '')} ${p.dia} a las ${hora}`;
}

/**
 * Fecha y hora para un mensaje al equipo: "lunes 24/08 a las 14:00".
 *
 * Distinto de formatearNegocio(), que da el formato técnico para los logs.
 * Acá el destinatario es una persona leyendo WhatsApp de apuro.
 */
export function formatearCita(fecha: Date, tz = TZ_NEGOCIO): string {
  const p = partesEnNegocio(fecha, tz);
  const dia = new Intl.DateTimeFormat('es', { timeZone: tz, weekday: 'long' }).format(fecha);
  const dd = String(p.dia).padStart(2, '0');
  const mm = String(p.mes).padStart(2, '0');
  const hora = `${String(p.hora).padStart(2, '0')}:${String(p.minuto).padStart(2, '0')}`;
  return `${dia} ${dd}/${mm} a las ${hora}`;
}
