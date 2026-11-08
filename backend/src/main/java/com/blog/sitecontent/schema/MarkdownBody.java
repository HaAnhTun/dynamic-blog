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
 * A Markdown document stored as given: line breaks and tabs are allowed, every other control character is not, and the
 * length (code points) is at most {@code max}. An empty text means "none". A null value is accepted: the field is
 * optional.
 */
@Documented
@Constraint(validatedBy = MarkdownBody.Validator.class)
@Target({FIELD, METHOD, PARAMETER, TYPE_USE})
@Retention(RetentionPolicy.RUNTIME)
public @interface MarkdownBody {

    String message() default "is not a valid Markdown text";

    Class<?>[] groups() default {};

    Class<? extends Payload>[] payload() default {};

    int max() default Integer.MAX_VALUE;

    class Validator implements ConstraintValidator<MarkdownBody, String> {

        private int max;

        @Override
        public void initialize(MarkdownBody annotation) {
            this.max = annotation.max();
        }

        @Override
        public boolean isValid(String value, ConstraintValidatorContext context) {
            return Violations.report(context, value == null ? null : TextRules.documentProblem(value, max));
        }
    }
}
