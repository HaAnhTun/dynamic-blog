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
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.regex.Pattern;

/** A real calendar date written {@code YYYY-MM-DD}. Required. */
@Documented
@Constraint(validatedBy = IsoDate.Validator.class)
@Target({FIELD, METHOD, PARAMETER, TYPE_USE})
@Retention(RetentionPolicy.RUNTIME)
public @interface IsoDate {

    String message() default "must be a date written YYYY-MM-DD";

    Class<?>[] groups() default {};

    Class<? extends Payload>[] payload() default {};

    class Validator implements ConstraintValidator<IsoDate, String> {

        private static final Pattern SHAPE = Pattern.compile("\\d{4}-\\d{2}-\\d{2}");

        @Override
        public boolean isValid(String value, ConstraintValidatorContext context) {
            if (value == null) {
                return Violations.report(context, "is required");
            }
            if (!SHAPE.matcher(value).matches()) {
                return false;
            }
            try {
                LocalDate.parse(value);
                return true;
            } catch (DateTimeParseException e) {
                return false;
            }
        }
    }
}
