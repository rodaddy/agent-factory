// Run errors that mean "config, not transient": a retry fails the same way.
// Only strings the queue-waste probe saw fail repeatedly; add one
// when a probe shows it.
export const POISON = ["Configured Pi model is unavailable", "Could not create working directory"];
