// Exercises: interfaces, class inheritance, abstract methods,
// accessors (get/set), static members, readonly fields, protected access,
// implements vs extends, and constructor parameter properties.

import { randomUUID } from "node:crypto";

/** A point on a 2D plane. Used by shapes for positioning. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Drawable {
  /** Returns a stringified description of the shape for debug output. */
  describe(): string;
  readonly id: string;
}

export interface Measurable {
  area(): number;
  perimeter(): number;
}

abstract class Shape implements Drawable, Measurable {
  // Created once at construction; never changes.
  public readonly id: string;
  protected origin: Point;
  private static instanceCount = 0;

  constructor(origin: Point) {
    this.id = randomUUID();
    this.origin = origin;
    Shape.instanceCount += 1;
  }

  static get count(): number {
    return Shape.instanceCount;
  }

  get position(): Point {
    return this.origin;
  }

  set position(next: Point) {
    // Defensive copy so callers can't mutate state via aliasing.
    this.origin = { x: next.x, y: next.y };
  }

  abstract area(): number;
  abstract perimeter(): number;

  describe(): string {
    return `${this.constructor.name}#${this.id.slice(0, 8)} @ (${this.origin.x},${this.origin.y})`;
  }
}

export class Rectangle extends Shape {
  constructor(
    origin: Point,
    public readonly width: number,
    public readonly height: number,
  ) {
    super(origin);
  }

  override area(): number {
    return this.width * this.height;
  }

  override perimeter(): number {
    return 2 * (this.width + this.height);
  }
}

export class Square extends Rectangle {
  constructor(origin: Point, side: number) {
    super(origin, side, side);
  }

  // Squares get a friendlier description.
  override describe(): string {
    return `Square(${this.width}) @ (${this.position.x},${this.position.y})`;
  }
}

export class Circle extends Shape {
  static readonly TAU = Math.PI * 2;

  constructor(
    origin: Point,
    public readonly radius: number,
  ) {
    super(origin);
  }

  override area(): number {
    return Math.PI * this.radius ** 2;
  }

  override perimeter(): number {
    return Circle.TAU * this.radius;
  }
}

export function totalArea(shapes: readonly Measurable[]): number {
  let sum = 0;
  for (const shape of shapes) {
    sum += shape.area();
  }
  return sum;
}

/** Factory helper used by tests; intentionally tiny. */
export function makeUnitShapes(): Shape[] {
  return [
    new Square({ x: 0, y: 0 }, 1),
    new Rectangle({ x: 1, y: 1 }, 2, 3),
    new Circle({ x: 0, y: 0 }, 1),
  ];
}
