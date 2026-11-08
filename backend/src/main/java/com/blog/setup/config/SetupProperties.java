package com.blog.setup.config;

import java.nio.file.Path;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * First-run setup, bound from {@code app.setup.*}.
 *
 * {@code token} ({@code SETUP_TOKEN}) is the setup code when it has a value. It is kept as a string and only checked in
 * {@link #configuredToken()}, like {@code ADMIN_GITHUB_ID}: if a bad value broke the binding of the record, Boot's
 * startup failure message would print the value of the property being bound, and that value is a secret.
 *
 * @param token       the setup code chosen by the operator; empty means "generate one into {@link #codeFile()}"
 * @param dataDir     the directory of the generated code file ({@code SETUP_DATA_DIR}); blank means {@value #DEFAULT_DATA_DIR}
 * @param lockDevSeed while setup is required, disable the development password of the seeded admin at startup
 */
@ConfigurationProperties("app.setup")
public record SetupProperties(
        String token,
        @DefaultValue(DEFAULT_DATA_DIR) String dataDir,
        @DefaultValue("true") boolean lockDevSeed) {

    /** The setup code is a secret: never let the default record printout show it. */
    @Override
    public String toString() {
        return "SetupProperties[token=<hidden>, dataDir=" + dataDir + ", lockDevSeed=" + lockDevSeed + "]";
    }

    public static final int MIN_TOKEN_LENGTH = 24;
    public static final String DEFAULT_DATA_DIR = "./data";
    public static final String CODE_FILE_NAME = "setup-code";

    /**
     * @return the stripped {@code SETUP_TOKEN}; null when it is blank
     * @throws IllegalStateException when it is shorter than {@value #MIN_TOKEN_LENGTH} characters. The message names only
     *                               the variable, never the value.
     */
    public String configuredToken() {
        if (token == null || token.isBlank()) {
            return null;
        }
        String value = token.strip();
        if (value.length() < MIN_TOKEN_LENGTH) {
            throw new IllegalStateException("SETUP_TOKEN (app.setup.token) must be at least " + MIN_TOKEN_LENGTH
                    + " characters long. Leave it empty to use the setup code file the backend generates.");
        }
        return value;
    }

    /** The absolute path of the generated setup code file: {@code <dataDir>/setup-code}. */
    public Path codeFile() {
        return dataFile(CODE_FILE_NAME);
    }

    /**
     * The absolute path of a file kept next to the setup code, in the data directory the operator already protects (the
     * enrollment code of two-step verification lives there too).
     */
    public Path dataFile(String name) {
        String directory = dataDir == null || dataDir.isBlank() ? DEFAULT_DATA_DIR : dataDir.strip();
        return Path.of(directory).toAbsolutePath().normalize().resolve(name);
    }
}
