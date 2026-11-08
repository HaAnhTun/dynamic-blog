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
 * A plain text field: no control character (newlines included), no leading or trailing whitespace, length within
 * {@code min..max} (code points). A null value is rejected unless {@code nullable}.
 */
@Documented
@Constraint(validatedBy = PlainText.Validator.class)
@Target({FIELD, METHOD, PARAMETER, TYPE_USE})
@Retention(RetentionPolicy.RUNTIME)
public @interface PlainText {

    String message() default "is not a valid plain text";

    Class<?>[] groups() default {};

    Class<? extends Payload>[] payload() default {};

    int min() default 0;

    int max() default Integer.MAX_VALUE;

    boolean nullable() default false;

    class Validator implements ConstraintValidator<PlainText, String> {

        private int min;
        private int max;
        private boolean nullable;

        @Override
        public void initialize(PlainText annotation) {
            this.min = annotation.min();
            this.max = annotation.max();
            this.nullable = annotation.nullable();
        }

        @Override
        public boolean isValid(String value, ConstraintValidatorContext context) {
            String problem = value == null ? (nullable ? null : "is required") : TextRules.problem(value, min, max);
            return Violations.report(context, problem);
        }
    }
}
