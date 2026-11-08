package com.blog.sitecontent.schema;

import static java.lang.annotation.ElementType.FIELD;
import static java.lang.annotation.ElementType.METHOD;
import static java.lang.annotation.ElementType.PARAMETER;
import static java.lang.annotation.ElementType.TYPE_USE;

import jakarta.validation.Constraint;
import jakarta.validation.ConstraintValidator;
import jakarta.validation.ConstraintValidatorContext;
import jakarta.validation.Payload;
import java.lang.annotation.Documented;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/**
 * A link that is safe to put in an {@code href}: an allow-list of schemes checked on the parsed URI (case-insensitive),
 * so {@code javascript:}, {@code data:}, {@code http:}, protocol-relative and scheme-less values are all rejected.
 */
@Documented
@Constraint(validatedBy = SafeUrl.Validator.class)
@Target({FIELD, METHOD, PARAMETER, TYPE_USE})
@Retention(RetentionPolicy.RUNTIME)
public @interface SafeUrl {

    String message() default "is not a safe URL";

    Class<?>[] groups() default {};

    Class<? extends Payload>[] payload() default {};

    Mode mode() default Mode.HTTPS;

    int max() default 200;

    boolean nullable() default false;

    enum Mode {
        /** {@code https://host/...} only. */
        HTTPS,
        /** {@code https://} or {@code mailto:}. */
        HTTPS_OR_MAILTO,
        /** {@code https://} or a path of this site: one leading slash, no scheme. */
        HTTPS_OR_PATH
    }

    class Validator implements ConstraintValidator<SafeUrl, String> {

        private Mode mode;
        private int max;
        private boolean nullable;

        @Override
        public void initialize(SafeUrl annotation) {
            this.mode = annotation.mode();
            this.max = annotation.max();
            this.nullable = annotation.nullable();
        }

        @Override
        public boolean isValid(String value, ConstraintValidatorContext context) {
            if (value == null) {
                return Violations.report(context, nullable ? null : "is required");
            }
            String problem = TextRules.problem(value, 1, max);
            if (problem == null && !allowed(value)) {
                problem = switch (mode) {
                    case HTTPS -> "must be an https URL";
                    case HTTPS_OR_MAILTO -> "must be an https or mailto URL";
                    case HTTPS_OR_PATH -> "must be an https URL or a path of this site";
                };
            }
            return Violations.report(context, problem);
        }

        private boolean allowed(String value) {
            if (value.indexOf('\\') >= 0 || value.chars().anyMatch(Character::isWhitespace)) {
                return false;
            }
            URI uri;
            try {
                uri = new URI(value);
            } catch (URISyntaxException e) {
                return false;
            }
            String scheme = uri.getScheme() == null ? null : uri.getScheme().toLowerCase(Locale.ROOT);
            if (scheme == null) {
                return mode == Mode.HTTPS_OR_PATH
                        && value.startsWith("/")
                        && !value.startsWith("//")
                        && uri.getRawAuthority() == null;
            }
            if ("https".equals(scheme)) {
                return uri.getHost() != null && uri.getRawUserInfo() == null;
            }
            return "mailto".equals(scheme)
                    && mode == Mode.HTTPS_OR_MAILTO
                    && uri.isOpaque()
                    && uri.getRawSchemeSpecificPart() != null
                    && !uri.getRawSchemeSpecificPart().isEmpty();
        }
    }
}
