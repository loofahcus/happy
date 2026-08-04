export class CircularBuffer<T> {
  private buf: (T | undefined)[];
  private head = 0;
  private _size = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buf = new Array(capacity);
  }

  push(item: T): void {
    const tail = (this.head + this._size) % this.capacity;
    this.buf[tail] = item;
    if (this._size < this.capacity) {
      this._size++;
    } else {
      this.head = (this.head + 1) % this.capacity;
    }
  }

  get length(): number {
    return this._size;
  }

  slice(from = 0): T[] {
    const start = Math.max(0, from);
    const count = this._size - start;
    if (count <= 0) return [];
    const result = new Array<T>(count);
    for (let i = 0; i < count; i++) {
      result[i] = this.buf[(this.head + start + i) % this.capacity] as T;
    }
    return result;
  }
}
