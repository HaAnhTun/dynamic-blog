package com.blog.common.security;

import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.sql.DataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.BeansException;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.jdbc.autoconfigure.JdbcConnectionDetails;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/**
 * Refuses to start in production ({@link ProductionMode}) when the backend reaches a PostgreSQL that is not on the machine itself or
 * on a private service name, without verifying the server. The link carries every password hash, session and post. pgjdbc's default
 * {@code sslmode=prefer} encrypts when the server offers it, falls back to plain text when it does not, and never checks who
 * answered, so on a split deployment (a managed database such as Neon or RDS, a backend on another machine) it is an open door for
 * whoever sits on the path.
 *
 * <ul>
 *   <li>{@code verify-full}: accepted, with the default factory (a root certificate file) or {@code DefaultJavaSSLFactory} (the JVM
 *       trust store).</li>
 *   <li>{@code require}, {@code verify-ca}: encrypted but the server's name is not proven (or not at all): one warning.</li>
 *   <li>{@code prefer} (the default), {@code allow}, {@code disable}, and any mode combined with {@code NonValidatingFactory}
 *       (which accepts every certificate): refused, unless {@code DB_ALLOW_INSECURE_TRANSPORT=true} says the operator trusts the
 *       network (a VPN or a VPC): then one warning.</li>
 * </ul>
 *
 * When a parameter is repeated, the last value counts, as it does in pgjdbc: {@code DB_JDBC_PARAMS} is appended after
 * {@code sslmode=${DB_SSLMODE}}, so {@code &sslmode=disable} there overrides a {@code verify-full} before it.
 *
 * <b>What the remedy needs.</b> The pgjdbc default factory ({@code LibPQFactory}) reads the root certificate from {@code sslrootcert}, or
 * from {@code ~/.postgresql/root.crt}, and fails with "Could not open SSL root certificate file" when there is none. It does not fall
 * back to the JVM trust store and has no {@code sslrootcert=system}. So {@code DB_SSLMODE=verify-full} alone cannot connect. A
 * certificate from a public CA (Neon, for example) is checked against the JVM's own trust store with
 * {@code &sslfactory=org.postgresql.ssl.DefaultJavaSSLFactory} (the host name is still checked, because the mode is verify-full); any
 * other CA (the Amazon RDS one, a private one) needs {@code &sslrootcert=<file>}, a file the user the backend runs as can read.
 *
 * <b>When it runs.</b> As a {@link BeanPostProcessor} of the {@link DataSource}: the check fires when that bean is created, before it is
 * handed to Flyway, Hibernate or anything else, so the first connection is never opened over an unverified link. (An
 * {@code ApplicationRunner} would run after Flyway had already migrated through it.) Pgjdbc connects lazily, so creating the bean opens
 * no connection.
 *
 * A host that is {@code localhost}, a loopback address, or a single-label name (the Compose service {@code postgres}, resolved on a
 * private network) is exempt, and so is a dev machine. The message names the host and the variable, never the rest of the URL: it
 * may carry {@code user=} and {@code password=} parameters.
 */
@Component
public class DatabaseTransportCheck implements BeanPostProcessor {

    private static final Logger log = LoggerFactory.getLogger(DatabaseTransportCheck.class);

    private static final Pattern URL = Pattern.compile("^jdbc:postgresql://([^/?]+)(?:/[^?]*)?(?:\\?(.*))?$");
    private static final Set<String> KNOWN_MODES =
            Set.of("disable", "allow", "prefer", "require", "verify-ca", "verify-full");

    /** pgjdbc's factory that accepts any certificate; the mode then only decides whether the name is compared. */
    private static final String NON_VALIDATING_FACTORY = "org.postgresql.ssl.NonValidatingFactory";

    /** The one fix the messages name for a public CA, and the one for every other CA. */
    private static final String REMEDY =
            "DB_SSLMODE=verify-full, plus DB_JDBC_PARAMS=&sslfactory=org.postgresql.ssl.DefaultJavaSSLFactory when the certificate "
                    + "is signed by a CA the JVM trusts, or DB_JDBC_PARAMS=&sslrootcert=<file> (a CA certificate file the backend's "
                    + "user can read) for any other CA";

    private final Supplier<String> jdbcUrl;
    private final BooleanSupplier productionRun;
    private final boolean allowInsecureTransport;
    private boolean checked;

    @Autowired
    public DatabaseTransportCheck(
            ObjectProvider<JdbcConnectionDetails> connection,
            ObjectProvider<ProductionMode> productionMode,
            Environment environment) {
        // Looked up when the data source is created, not now: a post-processor must not pull ordinary beans in while
        // the
        // post-processors are still being registered.
        this(
                () -> connection.getObject().getJdbcUrl(),
                () -> productionMode.getObject().active(),
                environment.getProperty("app.database.allow-insecure-transport", Boolean.class, false));
    }

    DatabaseTransportCheck(Supplier<String> jdbcUrl, BooleanSupplier productionRun, boolean allowInsecureTransport) {
        this.jdbcUrl = jdbcUrl;
        this.productionRun = productionRun;
        this.allowInsecureTransport = allowInsecureTransport;
    }

    @Override
    public Object postProcessBeforeInitialization(Object bean, String beanName) throws BeansException {
        if (bean instanceof DataSource && !checked) {
            verify();
            checked = true;
        }
        return bean;
    }

    void verify() {
        if (!productionRun.getAsBoolean()) {
            return;
        }
        String url = jdbcUrl.get();
        Matcher matcher = URL.matcher(url == null ? "" : url);
        if (!matcher.matches()) {
            throw new IllegalStateException(
                    "The JDBC URL of the database is not jdbc:postgresql://host[:port]/name, so the "
                            + "backend cannot tell whether its link to PostgreSQL is protected. Check DB_HOST, DB_PORT and DB_NAME.");
        }
        List<String> remote = Arrays.stream(matcher.group(1).split(","))
                .map(DatabaseTransportCheck::hostOf)
                .filter(host -> !isLocal(host))
                .toList();
        if (remote.isEmpty()) {
            return;
        }
        String host = remote.getFirst();
        String mode = lastValue(matcher.group(2), "sslmode", "prefer").toLowerCase(Locale.ROOT);
        boolean trustsEverything = NON_VALIDATING_FACTORY.equals(lastValue(matcher.group(2), "sslfactory", ""));
        if ("verify-full".equals(mode) && !trustsEverything) {
            // The only combination that proves who answered.
            return;
        }
        if (("require".equals(mode) || "verify-ca".equals(mode)) && !trustsEverything) {
            log.warn(
                    "The link to PostgreSQL on {} uses sslmode={}, which encrypts but does not prove the server is the one you "
                            + "meant. Use {}.",
                    host,
                    mode,
                    REMEDY);
            return;
        }
        if (!allowInsecureTransport) {
            throw new IllegalStateException("The backend connects to PostgreSQL on " + host + " without verifying the "
                    + "server (" + shown(mode, trustsEverything)
                    + ") in a production run: the link carries every password hash, "
                    + "session and post, and a default connection falls back to plain text. Set " + REMEDY
                    + ". On a private network you trust, DB_ALLOW_INSECURE_TRANSPORT=true accepts it with a warning.");
        }
        log.warn(
                "The link to PostgreSQL on {} is not protected ({}) and DB_ALLOW_INSECURE_TRANSPORT=true "
                        + "accepts it. Use {} unless the network is one you fully control.",
                host,
                shown(mode, trustsEverything),
                REMEDY);
    }

    /** The host of one {@code host[:port]} entry, without the square brackets of an IPv6 literal. */
    private static String hostOf(String entry) {
        String value = entry.strip();
        if (value.startsWith("[")) {
            int end = value.indexOf(']');
            return end < 0 ? value : value.substring(1, end);
        }
        int colon = value.lastIndexOf(':');
        return colon < 0 ? value : value.substring(0, colon);
    }

    /** The machine itself, or a single-label name such as a Compose service: reached over a network that is not shared. */
    private static boolean isLocal(String host) {
        return ProductionMode.isLoopbackHost(host) || (!host.isEmpty() && !host.contains(".") && !host.contains(":"));
    }

    /** The value of a query parameter; the last occurrence when it is repeated (pgjdbc keeps the last), else the fallback. */
    private static String lastValue(String query, String name, String fallback) {
        String value = fallback;
        if (query != null) {
            for (String parameter : query.split("&")) {
                int equals = parameter.indexOf('=');
                if (equals > 0 && parameter.substring(0, equals).equalsIgnoreCase(name)) {
                    value = parameter.substring(equals + 1).strip();
                }
            }
        }
        return value;
    }

    private static String shown(String mode, boolean trustsEverything) {
        String known = KNOWN_MODES.contains(mode) ? "sslmode=" + mode : "an unknown sslmode";
        return trustsEverything ? known + " with a factory that accepts any certificate" : known;
    }
}
