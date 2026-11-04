/** Usernames: 3 to 32 letters, digits, dots, dashes or underscores (compared case-insensitively). */
export const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,32}$/;

/** The rule in words, for form and configuration errors. */
export const USERNAME_RULE = "3 to 32 letters, digits, dots, dashes or underscores";
