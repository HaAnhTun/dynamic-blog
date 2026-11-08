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

/**
 * A plain address of up to 120 characters: one at sign, text on both sides, no whitespace and none of the characters that
 * could turn it into more than an address inside a mailto link (angle brackets, commas, quotes, {@code ? & = % ;}).
 */
@Documented
@Constraint(validatedBy = PlainEmail.Validator.class)
@Target({FIELD, METHOD, PARAMETER, TYPE_USE})
@Retention(RetentionPolicy.RUNTIME)
public @interface PlainEmail {

    String message() default "is not a valid email address";

    Class<?>[] groups() default {};

    Class<? extends Payload>[] payload() default {};

    boolean nullable() default false;

    class Validator implements ConstraintValidator<PlainEmail, String> {

        private static final int MAX = 120;

        private boolean nullable;

        @Override
        public void initialize(PlainEmail annotation) {
            this.nullable = annotation.nullable();
        }

        @Override
        public boolean isValid(String value, ConstraintValidatorContext context) {
            if (value == null) {
                return Violations.report(context, nullable ? null : "is required");
            }
            String problem = TextRules.problem(value, 1, MAX);
            if (problem == null) {
                int at = value.indexOf('@');
                boolean shaped = at > 0
                        && at == value.lastIndexOf('@')
                        && at < value.length() - 1
                        && value.chars().noneMatch(c -> Character.isWhitespace(c) || "<>,;?&=%\"'\\".indexOf(c) >= 0);
                problem = shaped ? null : "must be a plain email address";
            }
            return Violations.report(context, problem);
        }
    }
}
