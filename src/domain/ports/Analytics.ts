/** One product-analytics event. `distinctId` identifies an account, never a person's contact data. */
export interface AnalyticsEvent {
  name: string;
  distinctId: string;
  properties: Record<string, string | number | boolean>;
}

/** Fire-and-forget: an analytics outage never fails the caller. */
export interface Analytics {
  capture(event: AnalyticsEvent): void;
}
