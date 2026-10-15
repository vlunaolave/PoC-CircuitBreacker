/**
 * Historial acotado de la demostración.
 * Los textos se generan en el servidor; la interfaz solo los muestra.
 */

class EventLog {
  constructor(limit = 100) {
    this.limit = limit;
    this.events = [];
    this.nextId = 1;
  }

  add(message, at = new Date()) {
    this.events.push({
      id: this.nextId,
      at: at.toISOString(),
      message,
    });
    this.nextId += 1;
    if (this.events.length > this.limit) {
      this.events.splice(0, this.events.length - this.limit);
    }
  }

  list() {
    return this.events.map((event) => ({ ...event }));
  }

  clear() {
    this.events = [];
  }
}

module.exports = {
  EventLog,
};
