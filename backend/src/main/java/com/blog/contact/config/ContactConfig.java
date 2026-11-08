package com.blog.contact.config;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;

/** Registers {@link ContactProperties} and {@link ContactRetentionProperties}. The mail itself goes through the MailTransport bean of NewsletterConfig. */
@Configuration
@EnableConfigurationProperties({ContactProperties.class, ContactRetentionProperties.class})
public class ContactConfig {}
