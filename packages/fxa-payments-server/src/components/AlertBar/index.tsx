import React from 'react';

import './index.scss';
import Portal from '../Portal';

type AlertBarProps = {
  children: any;
  className?: string;
};

export const AlertBar = ({ children, className = 'alert' }: AlertBarProps) => {
  return (
    <Portal id="top-bar">
      <div data-testid="alert-container" className={className}>
        {children}
      </div>
    </Portal>
  );
};

export default AlertBar;
