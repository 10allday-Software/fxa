import React, {
  useContext,
  useCallback,
  useRef,
  useEffect,
  DetailedHTMLProps,
  FormHTMLAttributes,
  ChangeEvent,
} from 'react';
import { ReactStripeElements } from 'react-stripe-elements';
import classNames from 'classnames';
import { Validator, FieldType } from '../lib/validator';
import Tooltip from './Tooltip';

export type FormContextValue = { validator: Validator };
export const FormContext = React.createContext<FormContextValue | null>(null);

export type OnValidateFunction = (value: any) => { value: any; error: any };

type FormProps = {
  children: React.ReactNode;
  validator: Validator;
} & DetailedHTMLProps<FormHTMLAttributes<HTMLFormElement>, HTMLFormElement>;

export const Form = (props: FormProps) => {
  const { children, validator, ...formProps } = props;
  return (
    <form {...formProps}>
      <FormContext.Provider value={{ validator }}>
        {children}
      </FormContext.Provider>
    </form>
  );
};

type FieldGroupProps = { children: React.ReactNode };

export const FieldGroup = ({ children }: FieldGroupProps) => (
  <div className="input-row-group">{children}</div>
);

type FieldProps = {
  name: string;
  initialValue?: any;
  tooltip?: boolean;
  required?: boolean;
  label?: string | React.ReactNode;
  className?: string;
  maxLength?: number;
  minLength?: number;
};

type FieldHOCProps = {
  fieldType: FieldType;
  tooltipParentRef?: React.MutableRefObject<any>;
  children: React.ReactNode;
} & FieldProps;

export const Field = ({
  tooltipParentRef,
  fieldType,
  name,
  initialValue = null,
  tooltip = true,
  required = false,
  label,
  className = 'input-row',
  children,
}: FieldHOCProps) => {
  const { validator } = useContext(FormContext) as FormContextValue;

  // Disabling lint rule because registering a field changes the validator
  // instance, so including validator in list of deps causes an infinite loop
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(
    () => validator.registerField({ name, initialValue, required, fieldType }),
    [name, required, fieldType]
  );
  /* eslint-enable react-hooks/exhaustive-deps */

  return (
    <div className={className}>
      <label>
        {label && <span className="label-text">{label}</span>}
        {children}
        {tooltip && tooltipParentRef && validator.getError(name) && (
          <Tooltip parentRef={tooltipParentRef}>
            {validator.getError(name)}
          </Tooltip>
        )}
      </label>
    </div>
  );
};

type InputProps = { onValidate?: OnValidateFunction } & FieldProps &
  React.DetailedHTMLProps<
    React.InputHTMLAttributes<HTMLInputElement>,
    HTMLInputElement
  >;

export const Input = (props: InputProps) => {
  const {
    name,
    label,
    initialValue,
    onValidate,
    tooltip,
    required = false,
    className,
    ...childProps
  } = props;

  const { validator } = useContext(FormContext) as FormContextValue;

  const onChange = useCallback(
    ev => {
      const { value } = ev.target;
      validator.updateField({ name, value });
    },
    [name, validator]
  );

  const onBlur = useCallback(
    ev => {
      const { value } = ev.target;
      if (onValidate) {
        const { value: newValue, error } = onValidate(value);
        validator.updateField({
          name,
          value: newValue,
          error,
          valid: error === null,
        });
      } else if (required && value !== null && !value) {
        validator.updateField({ name, value, error: 'This field is required' });
      } else {
        validator.updateField({ name, value, valid: true });
      }
    },
    [name, validator, onValidate, required]
  );

  const tooltipParentRef = useRef<HTMLInputElement>(null);

  return (
    <Field
      {...{
        fieldType: 'input',
        tooltipParentRef,
        name,
        initialValue,
        tooltip,
        required,
        label,
        className,
      }}
    >
      <input
        {...{
          ...childProps,
          ref: tooltipParentRef,
          name,
          required,
          className: classNames({ invalid: validator.isInvalid(name) }),
          value: validator.getValue(name, ''),
          onBlur,
          onChange,
        }}
      />
    </Field>
  );
};

type StripeElementProps = { onValidate?: OnValidateFunction } & FieldProps & {
    component: any;
  } & ReactStripeElements.ElementProps;

export const StripeElement = (props: StripeElementProps) => {
  const {
    component: StripeElementComponent,
    name,
    tooltip,
    onValidate,
    required = false,
    label,
    className,
    ...childProps
  } = props;
  const { validator } = useContext(FormContext) as FormContextValue;
  const elementValue = useRef<stripe.elements.ElementChangeResponse>();

  const validateElementValue = useCallback(() => {
    const value = elementValue.current;
    if (onValidate) {
      const { value: newValue, error } = onValidate(value);
      validator.updateField({
        name,
        value: newValue,
        error,
        valid: error === null,
      });
    } else if (!value) {
      if (required) {
        validator.updateField({ name, value, error: `${label} is required` });
      }
    } else if (value.error && value.error.message) {
      let error = value.error.message;
      // Issue #1718 - remove periods from error messages from Stripe
      // for consistency with our own errors
      if (error.endsWith('.')) {
        error = error.slice(0, -1);
      }
      validator.updateField({ name, value, valid: false, error });
    } else if (value.complete) {
      validator.updateField({ name, value, valid: true });
    }
  }, [name, validator, label, onValidate, required]);

  const onChange = useCallback(
    (value: stripe.elements.ElementChangeResponse) => {
      elementValue.current = value;
      validateElementValue();
    },
    [validateElementValue]
  );

  const onBlur = useCallback(() => validateElementValue(), [
    validateElementValue,
  ]);

  const tooltipParentRef = useRef<any>(null);
  const stripeElementRef = (el: any) => {
    // HACK: Stripe elements stash their underlying DOM element in el._ref,
    // but we need it for Tooltip positioning
    if (el) {
      tooltipParentRef.current = el._ref;
    }
  };

  return (
    <Field
      {...{
        fieldType: 'stripe',
        tooltipParentRef,
        name,
        tooltip,
        required,
        label,
        className,
      }}
    >
      <StripeElementComponent
        {...{
          ...childProps,
          ref: stripeElementRef,
          onChange,
          onBlur,
        }}
      />
    </Field>
  );
};

type CheckboxProps = FieldProps &
  React.DetailedHTMLProps<
    React.InputHTMLAttributes<HTMLInputElement>,
    HTMLInputElement
  >;

export const Checkbox = (props: CheckboxProps) => {
  const {
    name,
    label,
    required = false,
    className = 'input-row input-row--checkbox',
    ...childProps
  } = props;
  const { validator } = useContext(FormContext) as FormContextValue;

  const onChange = useCallback(
    (ev: ChangeEvent<HTMLInputElement>) => {
      const value = ev.target.checked;
      if (required && !value) {
        validator.updateField({ name, value, valid: false });
      } else {
        validator.updateField({ name, value, valid: true });
      }
    },
    [name, validator, required]
  );

  return (
    <Field
      {...{ fieldType: 'input', name, className, required, tooltip: false }}
    >
      <input
        {...{
          ...childProps,
          type: 'checkbox',
          name,
          onChange,
          onBlur: onChange,
        }}
      />
      <span className="label-text checkbox">{label}</span>
    </Field>
  );
};

type SubmitButtonProps = { children: React.ReactNode } & FieldProps &
  React.DetailedHTMLProps<
    React.InputHTMLAttributes<HTMLButtonElement>,
    HTMLButtonElement
  >;

export const SubmitButton = (props: SubmitButtonProps) => {
  const {
    name,
    label,
    children,
    className,
    disabled = false,
    ...childProps
  } = props;
  const { validator } = useContext(FormContext) as FormContextValue;
  const buttonProps = {
    className,
    name,
    disabled: disabled || !validator.allValid(),
  };
  return (
    <button {...{ ...childProps, ...buttonProps, type: 'submit' }}>
      {children}
    </button>
  );
};
